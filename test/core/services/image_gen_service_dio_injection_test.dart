import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/core/models/app_settings.dart';
import 'package:lumimuse/core/services/image_gen_service.dart';
import 'package:path/path.dart' as p;

const _pathProviderChannel = MethodChannel('plugins.flutter.io/path_provider');
const _tinyPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

class _RecordedRequest {
  final String method;
  final String url;
  final dynamic data;
  final Map<String, dynamic> headers;

  const _RecordedRequest({
    required this.method,
    required this.url,
    required this.data,
    required this.headers,
  });
}

class _FakeDioAdapter implements HttpClientAdapter {
  final FutureOr<ResponseBody> Function(RequestOptions options) handler;
  final List<_RecordedRequest> requests = <_RecordedRequest>[];
  bool closed = false;

  _FakeDioAdapter(this.handler);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(_RecordedRequest(
      method: options.method,
      url: options.uri.toString(),
      data: options.data,
      headers: Map<String, dynamic>.from(options.headers),
    ));
    return handler(options);
  }

  @override
  void close({bool force = false}) {
    closed = true;
  }
}

ResponseBody _jsonResponse(Map<String, dynamic> data, {int statusCode = 200}) {
  return ResponseBody.fromString(
    jsonEncode(data),
    statusCode,
    headers: {
      Headers.contentTypeHeader: <String>[Headers.jsonContentType],
    },
  );
}

Dio _dioWith(_FakeDioAdapter adapter) {
  final dio = Dio();
  dio.httpClientAdapter = adapter;
  return dio;
}

Future<Directory> _mockDocumentsDir(String name) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  final dir = await Directory.systemTemp.createTemp(name);
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_pathProviderChannel, (call) async {
    if (call.method == 'getApplicationDocumentsDirectory' ||
        call.method == 'getTemporaryDirectory') {
      return dir.path;
    }
    return null;
  });
  return dir;
}

Future<void> _resetPathProviderMock(Directory dir) async {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(_pathProviderChannel, null);
  try {
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  } catch (_) {
    // Windows 上测试进程偶发短暂文件锁，清理失败不影响断言语义。
  }
}

void main() {
  group('ImageGenService Dio 注入 - SD WebUI', () {
    test('使用注入的 Dio 发送 txt2img 请求并保存 images[0]', () async {
      final docs = await _mockDocumentsDir('lumimuse_img_sd_ok_');
      final adapter = _FakeDioAdapter((options) {
        expect(options.method, 'POST');
        expect(
          options.uri.toString(),
          'http://sd.local/sdapi/v1/txt2img',
        );
        return _jsonResponse({
          'images': <String>[_tinyPngBase64],
        });
      });
      final service = ImageGenService(dio: _dioWith(adapter));
      addTearDown(() async {
        service.dispose();
        await _resetPathProviderMock(docs);
      });

      final path = await service.generate(
        prompt: 'girl with lantern',
        negativePrompt: 'blurry',
        settings: const ImageGenSettings(
          engine: 'sd',
          sdUrl: 'http://sd.local/',
          qualityTags: 'best quality',
        ),
      );

      expect(adapter.requests, hasLength(1));
      expect(adapter.requests.single.data, containsPair('negative_prompt', 'blurry'));
      expect(adapter.requests.single.data, containsPair('prompt', 'best quality, girl with lantern'));
      expect(path, startsWith(p.join(docs.path, 'LumiMuse', 'generated')));
      expect(File(path).existsSync(), isTrue);
      expect(File(path).readAsBytesSync(), base64Decode(_tinyPngBase64));
    });

    test('SD WebUI 缺少 images[0] 时抛出结构错误', () async {
      final docs = await _mockDocumentsDir('lumimuse_img_sd_bad_');
      final adapter = _FakeDioAdapter((_) => _jsonResponse({'images': <String>[]}));
      final service = ImageGenService(dio: _dioWith(adapter));
      addTearDown(() async {
        service.dispose();
        await _resetPathProviderMock(docs);
      });

      await expectLater(
        service.generate(
          prompt: 'girl',
          settings: const ImageGenSettings(engine: 'sd', sdUrl: 'http://sd.local'),
        ),
        throwsA(
          predicate((e) => e.toString().contains('SD WebUI 未返回图片')),
        ),
      );
      expect(adapter.requests, hasLength(1));
    });
  });

  group('ImageGenService Dio 注入 - 自定义 API', () {
    test('使用注入的 Dio 解析 data[0].b64_json 并发送鉴权头', () async {
      final docs = await _mockDocumentsDir('lumimuse_img_custom_ok_');
      final adapter = _FakeDioAdapter((options) {
        expect(options.method, 'POST');
        expect(options.uri.toString(), 'http://custom.local/images');
        expect(options.headers['Authorization'], 'Bearer sk-test');
        return _jsonResponse({
          'data': <Map<String, String>>[
            {'b64_json': _tinyPngBase64},
          ],
        });
      });
      final service = ImageGenService(dio: _dioWith(adapter));
      addTearDown(() async {
        service.dispose();
        await _resetPathProviderMock(docs);
      });

      final path = await service.generate(
        prompt: 'cat cafe',
        settings: const ImageGenSettings(
          engine: 'custom',
          customUrl: 'http://custom.local/images',
          customApiKey: 'sk-test',
          customModel: 'img-model',
          customSize: '512x512',
          qualityTags: 'warm light',
        ),
      );

      expect(adapter.requests, hasLength(1));
      expect(adapter.requests.single.data, containsPair('model', 'img-model'));
      expect(adapter.requests.single.data, containsPair('prompt', 'warm light, cat cafe'));
      expect(adapter.requests.single.data, containsPair('response_format', 'b64_json'));
      expect(path, startsWith(p.join(docs.path, 'LumiMuse', 'generated')));
      expect(File(path).readAsBytesSync(), base64Decode(_tinyPngBase64));
    });

    test('自定义 API 缺少可识别图片字段时抛出结构错误', () async {
      final docs = await _mockDocumentsDir('lumimuse_img_custom_bad_');
      final adapter = _FakeDioAdapter((_) => _jsonResponse({
            'data': <Map<String, String>>[
              {'revised_prompt': 'missing image payload'},
            ],
          }));
      final service = ImageGenService(dio: _dioWith(adapter));
      addTearDown(() async {
        service.dispose();
        await _resetPathProviderMock(docs);
      });

      await expectLater(
        service.generate(
          prompt: 'cat cafe',
          settings: const ImageGenSettings(
            engine: 'custom',
            customUrl: 'http://custom.local/images',
          ),
        ),
        throwsA(
          predicate((e) => e.toString().contains('自定义 API 返回格式无法解析')),
        ),
      );
      expect(adapter.requests, hasLength(1));
    });
  });
}
