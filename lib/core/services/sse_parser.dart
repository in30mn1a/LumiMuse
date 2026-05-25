import 'dart:convert';

class SseParser {
  String _buffer = '';

  /// 上一 chunk 末尾可能不完整的 UTF-8 字节序列，拼到下一 chunk 开头再解码。
  List<int> _pendingBytes = [];

  /// buffer 上限：1MB。超过则认为上游协议错误，清空避免无限增长 OOM。
  static const int _maxBufferBytes = 1024 * 1024;

  /// 判断字节是否为 UTF-8 起始字节，并返回该字符占用的总字节数。
  /// 0xxxxxxx → 1, 110xxxxx → 2, 1110xxxx → 3, 11110xxx → 4
  int _utf8SequenceLength(int byte) {
    if (byte < 0x80) return 1;
    if (byte >= 0xC0 && byte < 0xE0) return 2;
    if (byte >= 0xE0 && byte < 0xF0) return 3;
    if (byte >= 0xF0 && byte < 0xF8) return 4;
    return 1;
  }

  /// 从 chunk 末尾提取可能不完整的 UTF-8 序列。
  /// 返回应留给下一 chunk 的字节列表；完整部分已从 chunk 尾部移除。
  (List<int> completeChunk, List<int> pending) _splitTrailingUtf8(
    List<int> chunk,
  ) {
    if (chunk.isEmpty) return (chunk, const []);

    var i = chunk.length - 1;

    // 跳过尾部续字节（10xxxxxx）
    while (i >= 0 && (chunk[i] & 0xC0) == 0x80) {
      i--;
    }

    if (i < 0) {
      // 全是续字节，无法确定起始，全部 pending
      return (const [], chunk);
    }

    final leadByte = chunk[i];
    final expectedLen = _utf8SequenceLength(leadByte);
    final actualLen = chunk.length - i;

    if (actualLen >= expectedLen) {
      // 末尾序列完整，无需 pending
      return (chunk, const []);
    }

    // 末尾序列不完整：lead byte + 部分续字节，留给下一轮
    return (chunk.sublist(0, i), chunk.sublist(i));
  }

  List<Map<String, dynamic>> parseChunk(List<int> chunk) {
    // 拼接上一轮残留字节
    final combined = _pendingBytes.isNotEmpty
        ? [..._pendingBytes, ...chunk]
        : chunk;
    _pendingBytes = const [];

    // 从尾部拆出可能不完整的 UTF-8 序列
    final (completeChunk, pending) = _splitTrailingUtf8(combined);
    _pendingBytes = pending;

    // 完整部分用严格 UTF-8 解码（不再需要 allowMalformed）
    final decoded = utf8.decode(completeChunk, allowMalformed: false);
    _buffer += decoded;

    // FIX(Major-7): 统一换行符为 LF，兼容 CRLF 行尾的 SSE 流。
    // SSE 规范允许 \r\n / \n / \r，部分服务端（特别是经过 CDN 的 OpenAI 兼容
    // 代理）会输出 CRLF。旧实现仅 split('\n\n') 与 split('\n')，遇到 CRLF 时
    // 事件之间的分隔符变成 `\r\n\r\n`，无法被切分；而 `data: foo\r\n` 末尾会
    // 残留 `\r`，导致 `trimmed.startsWith('data: ')` 仍命中、jsonDecode 也能
    // 容忍尾部空白，但安全起见先把 \r\n 一律折叠成 \n 再走原始切分逻辑，
    // 避免后续维护中再踩坑。
    _buffer = _buffer.replaceAll('\r\n', '\n');

    // 防御：buffer 超过 1MB 视为异常，清空并返回空结果
    if (_buffer.length > _maxBufferBytes) {
      // ignore: avoid_print
      print(
        '[SseParser] buffer 超过 ${_maxBufferBytes ~/ 1024}KB，清空避免 OOM',
      );
      _buffer = '';
      _pendingBytes = const [];
      return const [];
    }

    final results = <Map<String, dynamic>>[];
    final parts = _buffer.split('\n\n');
    _buffer = parts.removeLast();

    for (final part in parts) {
      for (final line in part.split('\n')) {
        final trimmed = line.trim();
        if (trimmed.isEmpty || trimmed == 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          final json = jsonDecode(trimmed.substring(6));
          results.add(json as Map<String, dynamic>);
        } catch (_) {}
      }
    }
    return results;
  }

  List<Map<String, dynamic>> flush() {
    // flush 时把残留字节一并解码（流已结束，不会有下一 chunk）
    if (_pendingBytes.isNotEmpty) {
      final decoded = utf8.decode(_pendingBytes, allowMalformed: true);
      _buffer += decoded;
      _pendingBytes = const [];
    }

    // FIX(Major-7): 同 parseChunk，flush 阶段也把 CRLF 折叠为 LF 后再切分，
    // 避免最后一段携带 \r 的事件因为 split('\n') 残留 \r 而无法解析。
    _buffer = _buffer.replaceAll('\r\n', '\n');

    if (_buffer.trim().isEmpty) return [];
    final results = <Map<String, dynamic>>[];
    for (final line in _buffer.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.isEmpty ||
          trimmed == 'data: [DONE]' ||
          !trimmed.startsWith('data: ')) {
        continue;
      }
      try {
        final json = jsonDecode(trimmed.substring(6));
        results.add(json as Map<String, dynamic>);
      } catch (_) {}
    }
    _buffer = '';
    return results;
  }

  void reset() {
    _buffer = '';
    _pendingBytes = const [];
  }
}
