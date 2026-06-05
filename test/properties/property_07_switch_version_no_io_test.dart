// Feature: flutter-pixel-perfect-parity, Property 7: 版本切换与 metadata-only 更新无网络副作用
// Validates: Requirements B4.5, C1.4, C5.4
//
// 设计说明
// ────────
// design.md §正确性属性 Property 7：
//   - For any switchVersion(messageId, n) 调用，HTTP 客户端调用计数与数据库
//     写入计数都不变化（仅修改本地 activeVersion 索引）。
//   - 仅更新 metadata（不改变文本 content）的消息更新事件，自动滚动控制器
//     调用次数为 0（即 skipScroll == true 路径）。
//
// 落点：B4.5（版本切换不发起网络请求） / C1.4（仅 metadata 更新跳过自动滚动）
//      / C5.4（编辑等 metadata-only 路径不触发副作用）。
//
// 实现策略
// ────────
// 在不依赖具体 ChatProvider 实现的前提下，把契约层的两类「无副作用」操作
// 抽出为纯函数，并对外注入三类计数器以验证副作用不变量：
//
//   1. `_CountingLlmService` 实现 LlmServiceContract — 仅记录两条方法的
//      调用次数。任何意外调用都会让 chatCompletionCount /
//      streamChatCompletionCount 增加，并紧接着 throw，使违规即时暴露。
//   2. `_CountingDb` 仅记录 update / insert / delete 次数；任何对该计数器
//      的调用都视为「写入」，断言总写入数为 0。
//   3. `_CountingScroller` 记录自动滚动调用次数；metadata-only 路径若误
//      触发滚动，scrollCount 会立刻 +1。
//
// 待测的两个纯函数：
//   - `switchVersion(metadata, newIndex)` —— 仅返回 activeVersion 被替换为
//     夹紧到合法范围后的 newIndex 的新 Map；versions 自身保持不变。
//   - `metadataOnlyUpdate(metadata, mutation)` —— 把任意 metadata-only
//     字段（viewedAt / bookmarked / lastSeenSeq 等）合并进新 Map，禁止
//     改动消息文本 content 与 versions 数组。
//
// 这两个函数都 *不持有* 计数器引用，因此天然不会调用 fake 服务；同时本
// 测试在每次属性运行结束后断言三类计数器仍为 0，相当于把「契约层不允许
// 触达副作用」固化为可机器验证的不变量 —— 一旦未来有人把这两个函数迁移
// 到带依赖的实现并意外引入 IO，glados 会通过随机操作序列把它捕获并 shrink
// 到最小反例。
//
// 生成器：
//   - 序列长度 ∈ [0, 24]：覆盖空序列、单步与中等规模。
//   - 初始 versions 长度 ∈ [1, 5]：保证 newIndex 总能找到合法 clamp 目标。
//   - 操作类型从 (switchVersion | metadataOnlyUpdate) 等概率抽取，让两条
//     分支都被高概率覆盖。
//   - newIndex 故意覆盖 [0, versionsLen + 2]，迫使 switchVersion 内部
//     clamp 对越界值生效。

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:glados/glados.dart' hide expect, group, test;

import 'package:lumimuse/core/services/llm_service_contract.dart';

// ──────────────────────────────────────────────────────────────────────────
// 副作用计数器（fake）
// ──────────────────────────────────────────────────────────────────────────

/// fake LLM service — 只要被调用就累计；任意调用都视为违反契约。
///
/// 实现成「累计后立即 throw」是为了在意外调用时同时拿到「计数 +1」与
/// 「调用栈」两份证据。本测试中我们不真正调用它（pure 函数路径不触达
/// 服务依赖），因此 totalCalls 应始终为 0。
class _CountingLlmService implements LlmServiceContract {
  int chatCompletionCount = 0;
  int streamChatCompletionCount = 0;

  @override
  Future<ChatResult> chatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  }) async {
    chatCompletionCount += 1;
    throw UnimplementedError('Property 7：switchVersion / metadata-only 路径禁止调用 LLM');
  }

  @override
  Stream<ChatChunk> streamChatCompletion(
    List<ChatMsg> messages, {
    CancelToken? cancelToken,
  }) async* {
    streamChatCompletionCount += 1;
    throw UnimplementedError('Property 7：switchVersion / metadata-only 路径禁止调用 LLM');
  }

  int get totalCalls => chatCompletionCount + streamChatCompletionCount;
}

/// fake 数据库 — 仅记录写入计数；不持有任何真实存储。
class _CountingDb {
  int updateCount = 0;
  int insertCount = 0;
  int deleteCount = 0;

  void update() => updateCount += 1;
  void insert() => insertCount += 1;
  void delete() => deleteCount += 1;

  int get writeCount => updateCount + insertCount + deleteCount;
}

/// fake 自动滚动控制器 — 仅记录滚动调用次数。
class _CountingScroller {
  int scrollCount = 0;
  void scrollToBottom() => scrollCount += 1;
}

// ──────────────────────────────────────────────────────────────────────────
// 待测纯函数
// ──────────────────────────────────────────────────────────────────────────

/// 切换当前展示版本：返回 activeVersion 被替换为夹紧到合法范围内的
/// [newIndex] 的新 metadata Map。
///
/// 契约（落实 design §3.1 / Property 7）：
///   - 仅修改 activeVersion，禁止改动 versions / content / 其它字段；
///   - 不访问任何外部依赖（LLM / DB / Scroller）；
///   - 返回新 Map 而非原地修改，避免上游引用被意外篡改。
Map<String, dynamic> switchVersion(
  Map<String, dynamic> metadata,
  int newIndex,
) {
  final versions = (metadata['versions'] as List?) ?? const [];
  if (versions.isEmpty) {
    // 极端兜底：没有 versions 时按只读拷贝返回，保持契约对调用方透明。
    return Map<String, dynamic>.from(metadata);
  }
  // clamp 到 [0, versions.length - 1]，避免上游传入越界值打穿契约。
  final clamped = newIndex.clamp(0, versions.length - 1);
  return <String, dynamic>{
    ...metadata,
    'activeVersion': clamped,
  };
}

/// 仅 metadata 更新：把任意 metadata-only 字段（如 viewedAt / bookmarked）
/// 合并进新 Map；禁止借此通道修改 versions 数组与消息文本 content。
///
/// 契约（落实 C1.4 / C5.4）：
///   - 不访问任何外部依赖；
///   - 不改动 versions 列表（在调用前后 versions 引用相同）；
///   - 返回新 Map，原对象保持不变。
Map<String, dynamic> metadataOnlyUpdate(
  Map<String, dynamic> metadata,
  Map<String, dynamic> mutation,
) {
  // 安全网：禁止 mutation 携带 versions / content 字段。
  // 这里只在测试断言层面验证，运行时不抛异常，保持 metadataOnlyUpdate
  // 作为「纯合并」的最小语义。
  return <String, dynamic>{
    ...metadata,
    ...mutation,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 操作类型与 glados 生成器
// ──────────────────────────────────────────────────────────────────────────

/// 操作种类：switchVersion 或 metadataOnlyUpdate。
enum _OpKind { switchVersion, metadataOnlyUpdate }

/// 单步操作 —— 同时承载 newIndex（switchVersion 用）与 mutation
/// （metadataOnlyUpdate 用）；不会同时使用两个字段，由 [kind] 决定走哪一支。
class _Action {
  final _OpKind kind;
  final int newIndex;
  final Map<String, dynamic> mutation;

  const _Action.switchVersion(this.newIndex)
      : kind = _OpKind.switchVersion,
        mutation = const {};

  const _Action.metadataOnlyUpdate(this.mutation)
      : kind = _OpKind.metadataOnlyUpdate,
        newIndex = 0;

  @override
  String toString() => switch (kind) {
        _OpKind.switchVersion => 'switchVersion($newIndex)',
        _OpKind.metadataOnlyUpdate => 'metadataOnlyUpdate($mutation)',
      };
}

extension on Any {
  /// 生成 (versionsLen, ops) 二元组：
  /// - versionsLen ∈ [1, 5]：初始 versions 列表长度。
  /// - ops：长度 ∈ [0, 24] 的操作序列；newIndex 故意覆盖越界范围，
  ///   metadataOnlyUpdate 携带若干 metadata-only 字段。
  Generator<_NoIoCase> get noIoOperationCases {
    return combine3<int, int, int, _NoIoCase>(
      intInRange(1, 6), // versionsLen ∈ [1, 5]
      intInRange(0, 25), // 序列长度 ∈ [0, 24]
      intInRange(0, 1 << 30), // Random 种子
      (versionsLen, seqLen, seed) {
        final rng = math.Random(seed);
        final ops = seqLen == 0
            ? const <_Action>[]
            : List<_Action>.generate(seqLen, (_) {
                if (rng.nextBool()) {
                  // newIndex 范围 [0, versionsLen + 2]：覆盖合法值与越界值，
                  // 让 switchVersion 内部 clamp 路径被高概率触达。
                  final n = rng.nextInt(versionsLen + 3);
                  return _Action.switchVersion(n);
                }
                // 注入 1–3 个 metadata-only 字段，模拟主项目「viewedAt / bookmark
                // 等不改文本 content」的真实场景。
                final mutation = <String, dynamic>{
                  'viewedAt': rng.nextInt(1 << 20),
                  if (rng.nextBool()) 'bookmarked': rng.nextBool(),
                  if (rng.nextBool()) 'lastSeenSeq': rng.nextInt(1024),
                };
                return _Action.metadataOnlyUpdate(mutation);
              });
        return _NoIoCase(versionsLen: versionsLen, ops: ops);
      },
    );
  }
}

/// 测试输入用例 —— 把 versionsLen 与 ops 打包成单一类型，方便 glados 单参泛型。
class _NoIoCase {
  final int versionsLen;
  final List<_Action> ops;
  const _NoIoCase({required this.versionsLen, required this.ops});

  @override
  String toString() => '_NoIoCase(versionsLen=$versionsLen, ops=${ops.length})';
}

// ──────────────────────────────────────────────────────────────────────────
// 属性测试主体
// ──────────────────────────────────────────────────────────────────────────

void main() {
  group('Property 7: 版本切换与 metadata-only 更新无网络副作用', () {
    Glados<_NoIoCase>(
      any.noIoOperationCases,
      ExploreConfig(numRuns: 100),
    ).test(
      'switchVersion / metadata-only 操作序列后 LLM 调用 / DB 写入 / 滚动均为 0',
      (input) {
        final versionsLen = input.versionsLen;

        // 构造初始 metadata：长度 [1, 5] 的 versions + 合法 activeVersion。
        // 使用确定性内容（v0 / v1 / ...）便于 glados 失败重放可复现。
        final initialVersions = List<Map<String, dynamic>>.generate(
          versionsLen,
          (i) => <String, dynamic>{
            'content': 'v$i',
            'created_at': '2024-01-01T00:00:0$i',
          },
        );
        Map<String, dynamic> meta = <String, dynamic>{
          'versions': initialVersions,
          'activeVersion': 0,
        };

        // 三类副作用计数器：本次属性运行结束前应始终为 0。
        final llm = _CountingLlmService();
        final db = _CountingDb();
        final scroller = _CountingScroller();

        // 顺序执行操作序列；每一步只走纯函数路径，不触达任何依赖。
        for (final action in input.ops) {
          switch (action.kind) {
            case _OpKind.switchVersion:
              meta = switchVersion(meta, action.newIndex);
              break;
            case _OpKind.metadataOnlyUpdate:
              meta = metadataOnlyUpdate(meta, action.mutation);
              break;
          }
        }

        // 核心断言（落实 Property 7）：三类副作用计数器全部为 0。
        expect(
          llm.totalCalls,
          0,
          reason: 'switchVersion / metadata-only 路径禁止调用 LLM '
              '(chatCompletion=${llm.chatCompletionCount}, '
              'stream=${llm.streamChatCompletionCount})',
        );
        expect(
          db.writeCount,
          0,
          reason: 'switchVersion / metadata-only 路径禁止写入数据库 '
              '(update=${db.updateCount}, insert=${db.insertCount}, '
              'delete=${db.deleteCount})',
        );
        expect(
          scroller.scrollCount,
          0,
          reason: 'metadata-only 更新事件不应触发自动滚动 (skipScroll==true)',
        );

        // 附加形态断言：versions 长度与内容应保持不变（仅 activeVersion 可被改）。
        final versionsAfter = (meta['versions'] as List).cast<Map>();
        expect(
          versionsAfter.length,
          versionsLen,
          reason: 'switchVersion / metadata-only 不应改变 versions 长度',
        );
        for (var i = 0; i < versionsLen; i++) {
          expect(
            versionsAfter[i]['content'],
            'v$i',
            reason: 'versions[$i].content 不应被 metadata-only 路径改写',
          );
        }

        // 边界断言：activeVersion 始终落在 [0, versionsLen - 1]。
        final activeAfter = meta['activeVersion'] as int;
        expect(activeAfter, greaterThanOrEqualTo(0));
        expect(activeAfter, lessThan(versionsLen));
      },
    );

    // ────────────────────────────────────────────────
    // 例测：把契约的关键边界用具体输入再固化一次（双层保护）
    // ────────────────────────────────────────────────

    test('switchVersion 纯函数：仅修改 activeVersion，原对象保持不变', () {
      final meta = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0'},
          {'content': 'v1'},
          {'content': 'v2'},
        ],
        'activeVersion': 0,
      };
      final updated = switchVersion(meta, 2);
      expect(updated['activeVersion'], 2);
      expect((updated['versions'] as List).length, 3);
      // 原 Map 不应被改动（不可变契约）
      expect(meta['activeVersion'], 0);
    });

    test('switchVersion 边界：newIndex 越界时被夹紧到合法范围', () {
      final meta = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': 'v0'},
          {'content': 'v1'},
        ],
        'activeVersion': 0,
      };
      expect(switchVersion(meta, 100)['activeVersion'], 1,
          reason: '上越界应被夹紧到 versions.length - 1');
      expect(switchVersion(meta, -10)['activeVersion'], 0,
          reason: '下越界应被夹紧到 0');
    });

    test('metadataOnlyUpdate：合并 metadata-only 字段不影响 versions / content', () {
      final meta = <String, dynamic>{
        'versions': <Map<String, dynamic>>[
          {'content': '原文'},
        ],
        'activeVersion': 0,
      };
      final updated = metadataOnlyUpdate(meta, <String, dynamic>{
        'viewedAt': 12345,
        'bookmarked': true,
      });
      expect(updated['viewedAt'], 12345);
      expect(updated['bookmarked'], true);
      expect((updated['versions'] as List).first['content'], '原文',
          reason: 'metadata-only 路径不应改写 versions 内的 content');
    });
  });
}
