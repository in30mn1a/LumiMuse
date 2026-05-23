// 槽位抽象（PageRegion / PageSlot / SlotAnchor / renderRegion）单元测试
//
// 覆盖范围（任务 2.4）：
//   ① order 重复或非严格递增 → 构造期触发 AssertionError；
//   ② renderRegion 按 order 升序排列子项，单一 anchor 与混合 anchor 两种场景下
//      MainAxisAlignment 与 Spacer 分隔均符合 design.md §UI 布局基准约定；
//   ③ 五页根 widget 的 baselineRegions 与
//      `test/fixtures/page_regions_baseline.json` 完全等价（name / order /
//      anchor / id 全部一致）。
//
// 注：构造期 assert 已强制 order 严格递增，因此无法用 [3, 1, 2] 这类乱序输入
// 测试 renderRegion 的「防御层 sort」；本测试只验证「合法输入下渲染顺序与
// 锚点编排正确」。
//
// Validates: Requirements A3.1.*, A3.2.*, A3.3.*, A3.4.*, A3.5.*

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lumimuse/features/characters/character_edit_page.dart';
import 'package:lumimuse/features/chat/chat_view.dart';
import 'package:lumimuse/features/home/home_page.dart';
import 'package:lumimuse/features/memories/memory_list_page.dart';
import 'package:lumimuse/features/settings/settings_page.dart';
import 'package:lumimuse/theme/page_region.dart';

void main() {
  // ───────────────────────────────────────────────────────────────────────
  // 测试 1：order 重复或非严格递增触发 AssertionError
  // ───────────────────────────────────────────────────────────────────────
  group('PageRegion 构造期 assert（任务 2.4 · 测试 1）', () {
    test('两个相同 order 触发 AssertionError', () {
      expect(
        () => PageRegion(
          name: 'duplicateOrder',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 1,
              anchor: SlotAnchor.end,
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    test('order 非严格递增（如 [3, 1]）触发 AssertionError', () {
      expect(
        () => PageRegion(
          name: 'descendingOrder',
          slots: [
            PageSlot(
              order: 3,
              anchor: SlotAnchor.start,
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    test('order 严格递增 [1, 2, 3] 不触发 assert', () {
      expect(
        () => PageRegion(
          name: 'strictlyAscending',
          slots: [
            PageSlot(
              order: 1,
              anchor: SlotAnchor.start,
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 2,
              anchor: SlotAnchor.start,
              build: (_) => const SizedBox.shrink(),
            ),
            PageSlot(
              order: 3,
              anchor: SlotAnchor.start,
              build: (_) => const SizedBox.shrink(),
            ),
          ],
        ),
        returnsNormally,
      );
    });

    test('空 slots 列表合法', () {
      // 空 Region 是合法形态（例如某弹层尚未注入任何槽位），不应触发 assert。
      expect(
        () => PageRegion(name: 'empty', slots: const []),
        returnsNormally,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 测试 2：renderRegion 排序与锚点编排正确
  // ───────────────────────────────────────────────────────────────────────
  group('renderRegion 按 order 升序渲染（任务 2.4 · 测试 2）', () {
    /// 构造一个带稳定 Key 的占位子树，便于在 Row 子节点列表中按位置取键比对。
    Widget keyed(String id) => SizedBox(
          key: ValueKey('slot_$id'),
          width: 1,
          height: 1,
        );

    /// 把 [renderRegion] 包到一个最小的 MaterialApp 树里 pump，避免触发
    /// MediaQuery / Directionality 等隐式依赖缺失的报错。
    Future<Row> pumpAndFindRow(WidgetTester tester, PageRegion region) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: renderRegion(region)),
        ),
      );
      return tester.widget<Row>(find.byType(Row));
    }

    testWidgets('单一 anchor — 全 start，按 order 升序排列且 mainAxisAlignment.start', (tester) async {
      final region = PageRegion(
        name: 'singleStart',
        slots: [
          PageSlot(
            order: 1,
            anchor: SlotAnchor.start,
            id: 'a',
            build: (_) => keyed('a'),
          ),
          PageSlot(
            order: 2,
            anchor: SlotAnchor.start,
            id: 'b',
            build: (_) => keyed('b'),
          ),
          PageSlot(
            order: 3,
            anchor: SlotAnchor.start,
            id: 'c',
            build: (_) => keyed('c'),
          ),
        ],
      );

      final row = await pumpAndFindRow(tester, region);
      expect(row.mainAxisAlignment, MainAxisAlignment.start);
      expect(row.children.length, 3);
      expect((row.children[0].key as ValueKey).value, 'slot_a');
      expect((row.children[1].key as ValueKey).value, 'slot_b');
      expect((row.children[2].key as ValueKey).value, 'slot_c');
    });

    testWidgets('单一 anchor — 全 center，对齐 center', (tester) async {
      final region = PageRegion(
        name: 'singleCenter',
        slots: [
          PageSlot(
            order: 1,
            anchor: SlotAnchor.center,
            id: 'a',
            build: (_) => keyed('a'),
          ),
          PageSlot(
            order: 2,
            anchor: SlotAnchor.center,
            id: 'b',
            build: (_) => keyed('b'),
          ),
        ],
      );

      final row = await pumpAndFindRow(tester, region);
      expect(row.mainAxisAlignment, MainAxisAlignment.center);
      expect(row.children.length, 2);
      expect((row.children[0].key as ValueKey).value, 'slot_a');
      expect((row.children[1].key as ValueKey).value, 'slot_b');
    });

    testWidgets('单一 anchor — 全 end，对齐 end', (tester) async {
      final region = PageRegion(
        name: 'singleEnd',
        slots: [
          PageSlot(
            order: 1,
            anchor: SlotAnchor.end,
            id: 'a',
            build: (_) => keyed('a'),
          ),
          PageSlot(
            order: 2,
            anchor: SlotAnchor.end,
            id: 'b',
            build: (_) => keyed('b'),
          ),
        ],
      );

      final row = await pumpAndFindRow(tester, region);
      expect(row.mainAxisAlignment, MainAxisAlignment.end);
      expect(row.children.length, 2);
      expect((row.children[0].key as ValueKey).value, 'slot_a');
      expect((row.children[1].key as ValueKey).value, 'slot_b');
    });

    testWidgets('混合 anchor — start + center + end 三段式，两段 Spacer 分隔', (tester) async {
      final region = PageRegion(
        name: 'mixedThree',
        slots: [
          PageSlot(
            order: 1,
            anchor: SlotAnchor.start,
            id: 's',
            build: (_) => keyed('s'),
          ),
          PageSlot(
            order: 2,
            anchor: SlotAnchor.center,
            id: 'c',
            build: (_) => keyed('c'),
          ),
          PageSlot(
            order: 3,
            anchor: SlotAnchor.end,
            id: 'e',
            build: (_) => keyed('e'),
          ),
        ],
      );

      final row = await pumpAndFindRow(tester, region);
      // [start..., Spacer, center..., Spacer, end...]
      expect(row.children.length, 5);
      expect((row.children[0].key as ValueKey).value, 'slot_s');
      expect(row.children[1], isA<Spacer>());
      expect((row.children[2].key as ValueKey).value, 'slot_c');
      expect(row.children[3], isA<Spacer>());
      expect((row.children[4].key as ValueKey).value, 'slot_e');
    });

    testWidgets('混合 anchor — 仅 start + end，单段 Spacer 顶开两端', (tester) async {
      final region = PageRegion(
        name: 'startAndEnd',
        slots: [
          PageSlot(
            order: 1,
            anchor: SlotAnchor.start,
            id: 's',
            build: (_) => keyed('s'),
          ),
          PageSlot(
            order: 2,
            anchor: SlotAnchor.end,
            id: 'e',
            build: (_) => keyed('e'),
          ),
        ],
      );

      final row = await pumpAndFindRow(tester, region);
      expect(row.children.length, 3);
      expect((row.children[0].key as ValueKey).value, 'slot_s');
      expect(row.children[1], isA<Spacer>());
      expect((row.children[2].key as ValueKey).value, 'slot_e');
    });

    testWidgets('混合 anchor — start 段内同 anchor 多 slot 仍按 order 升序', (tester) async {
      // 同一 anchor 内的相对顺序也必须严格按 order 排列。
      final region = PageRegion(
        name: 'startMulti',
        slots: [
          PageSlot(
            order: 1,
            anchor: SlotAnchor.start,
            id: 's1',
            build: (_) => keyed('s1'),
          ),
          PageSlot(
            order: 2,
            anchor: SlotAnchor.start,
            id: 's2',
            build: (_) => keyed('s2'),
          ),
          PageSlot(
            order: 3,
            anchor: SlotAnchor.end,
            id: 'e1',
            build: (_) => keyed('e1'),
          ),
          PageSlot(
            order: 4,
            anchor: SlotAnchor.end,
            id: 'e2',
            build: (_) => keyed('e2'),
          ),
        ],
      );

      final row = await pumpAndFindRow(tester, region);
      // [s1, s2, Spacer, e1, e2]
      expect(row.children.length, 5);
      expect((row.children[0].key as ValueKey).value, 'slot_s1');
      expect((row.children[1].key as ValueKey).value, 'slot_s2');
      expect(row.children[2], isA<Spacer>());
      expect((row.children[3].key as ValueKey).value, 'slot_e1');
      expect((row.children[4].key as ValueKey).value, 'slot_e2');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 测试 3：五页 baselineRegions 与 fixtures 基准 JSON 一致
  // ───────────────────────────────────────────────────────────────────────
  group('五页 baselineRegions 与 fixtures 基准 JSON 等价（任务 2.4 · 测试 3）', () {
    // 五页根 widget 的 baselineRegions 静态字段 → fixtures JSON 顶层 key 映射。
    // 弹层条目（如 ExportDialog / ImportDialog / ChatLightbox）若已写入 fixtures
    // 也只在这里被忽略，仅校验五个顶层页面，与 task 2.4 描述保持一致。
    final pageRegions = <String, List<PageRegion>>{
      'HomePage': HomePage.baselineRegions,
      'ChatView': ChatView.baselineRegions,
      'CharacterEditPage': CharacterEditPage.baselineRegions,
      'MemoryListPage': MemoryListPage.baselineRegions,
      'SettingsPage': SettingsPage.baselineRegions,
    };

    /// 把 [PageRegion] 列表序列化为与 fixtures JSON 同结构（只保留可断言字段：
    /// name / slots[].order / anchor / id），便于 deep equals 比较。
    List<Map<String, Object?>> serializeRegions(List<PageRegion> regions) {
      return regions
          .map<Map<String, Object?>>((r) => <String, Object?>{
                'name': r.name,
                'slots': r.slots
                    .map<Map<String, Object?>>((s) => <String, Object?>{
                          'order': s.order,
                          'anchor': s.anchor.name,
                          'id': s.id,
                        })
                    .toList(),
              })
          .toList();
    }

    /// 把 fixtures JSON 中某页的 raw 数据剪枝为同结构，避免未来 fixtures 顺手
    /// 加入的元数据字段（如假设的 `note` / `_comment`）干扰断言。
    List<Map<String, Object?>> normalizeFixtureRegions(Object? raw) {
      final list = (raw as List).cast<Map<String, dynamic>>();
      return list
          .map<Map<String, Object?>>((region) {
            final slots = (region['slots'] as List).cast<Map<String, dynamic>>();
            return <String, Object?>{
              'name': region['name'],
              'slots': slots
                  .map<Map<String, Object?>>((s) => <String, Object?>{
                        'order': s['order'],
                        'anchor': s['anchor'],
                        'id': s['id'],
                      })
                  .toList(),
            };
          })
          .toList();
    }

    test('fixtures 基准 JSON 文件存在且可解析', () {
      final file = File('test/fixtures/page_regions_baseline.json');
      expect(
        file.existsSync(),
        isTrue,
        reason: '缺失 test/fixtures/page_regions_baseline.json，'
            '该 fixtures 是 RC-11 与 task 2.4 的共同基准',
      );
      // 解析失败会抛 FormatException，让测试框架自然失败。
      final raw = jsonDecode(file.readAsStringSync());
      expect(raw, isA<Map<String, dynamic>>());
    });

    test('五页 baselineRegions 与 fixtures 等价（name / order / anchor / id）', () {
      final raw = jsonDecode(
        File('test/fixtures/page_regions_baseline.json').readAsStringSync(),
      ) as Map<String, dynamic>;

      for (final entry in pageRegions.entries) {
        final pageName = entry.key;
        final actual = serializeRegions(entry.value);

        expect(
          raw.containsKey(pageName),
          isTrue,
          reason: 'fixtures JSON 必须包含顶层条目 "$pageName"',
        );

        final expected = normalizeFixtureRegions(raw[pageName]);
        expect(
          actual,
          equals(expected),
          reason: '$pageName 的 baselineRegions 与 fixtures 基准不一致；'
              '若有子 spec 改动了 order / anchor / id，请同步更新两边并经评审。',
        );
      }
    });

    test('每页 baselineRegions 内部 order 严格递增（构造期 assert 已守住）', () {
      // 这条断言与构造期 assert 互为冗余，作为人类可读的回归提醒：
      // 一旦未来某页 baselineRegions 被改成乱序，这里也会立刻失败。
      for (final entry in pageRegions.entries) {
        final pageName = entry.key;
        for (final region in entry.value) {
          for (var i = 1; i < region.slots.length; i++) {
            final prev = region.slots[i - 1].order;
            final curr = region.slots[i].order;
            expect(
              curr > prev,
              isTrue,
              reason: '$pageName · region "${region.name}" 的 slots[$i].order '
                  '($curr) 必须严格大于 slots[${i - 1}].order ($prev)',
            );
          }
        }
      }
    });
  });
}
