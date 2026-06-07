// 回归检查：侧边栏角色卡片拖拽排序
// 覆盖：
// 1. characters 表迁移加 sort_order 列
// 2. GET /api/characters 按 sort_order 排序
// 3. PUT /api/characters/reorder 接口存在
// 4. CharacterList 接入 @dnd-kit/sortable
// 5. 编辑按钮在拖拽态下仍可点（停止冒泡 + 拖动手柄分离）

const fs = require('fs');

const dbFile = fs.readFileSync('src/lib/db.ts', 'utf8');
const charactersRoute = fs.readFileSync('src/app/api/characters/route.ts', 'utf8');
const reorderRoute = fs.existsSync('src/app/api/characters/reorder/route.ts')
  ? fs.readFileSync('src/app/api/characters/reorder/route.ts', 'utf8')
  : '';
const characterList = fs.readFileSync('src/components/sidebar/CharacterList.tsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const checks = [
  ['package.json 包含 @dnd-kit/core', !!pkg.dependencies?.['@dnd-kit/core']],
  ['package.json 包含 @dnd-kit/sortable', !!pkg.dependencies?.['@dnd-kit/sortable']],
  ['package.json 包含 @dnd-kit/utilities', !!pkg.dependencies?.['@dnd-kit/utilities']],
  ['db 迁移：characters 表 sort_order 列存在性检查', /characters[\s\S]{0,400}sort_order/.test(dbFile) && dbFile.includes('ALTER TABLE characters ADD COLUMN sort_order')],
  ['db 迁移：旧数据按 updated_at 回填 sort_order', /UPDATE characters[\s\S]{0,200}sort_order[\s\S]{0,200}updated_at/.test(dbFile)],
  ['GET /api/characters 按 sort_order 排序', /ORDER BY[\s\S]{0,80}sort_order/.test(charactersRoute)],
  ['POST /api/characters 写入 sort_order（新角色顶部）', /sort_order/.test(charactersRoute) && /MIN\(sort_order\)|min_sort/.test(charactersRoute)],
  ['存在 PUT /api/characters/reorder 路由', reorderRoute.length > 0 && /export\s+async\s+function\s+PUT/.test(reorderRoute)],
  ['reorder 路由按 ids 顺序重写 sort_order', /ids/.test(reorderRoute) && /sort_order/.test(reorderRoute)],
  ['CharacterList 引入 @dnd-kit/core', /from\s+['"]@dnd-kit\/core['"]/.test(characterList)],
  ['CharacterList 引入 @dnd-kit/sortable', /from\s+['"]@dnd-kit\/sortable['"]/.test(characterList)],
  ['CharacterList 使用 SortableContext', characterList.includes('SortableContext')],
  ['CharacterList 使用 useSortable', characterList.includes('useSortable')],
  ['CharacterList 调用 reorder API', /\/api\/characters\/reorder/.test(characterList)],
  ['长按延时启用（移动端避开滚动冲突）', /TouchSensor[\s\S]{0,300}delay/.test(characterList) || /activationConstraint[\s\S]{0,200}delay/.test(characterList)],
  ['拖拽手柄不吞编辑按钮（attributes/listeners 仅作用在卡片本体）', /listeners/.test(characterList) && /stopPropagation/.test(characterList)],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error('角色卡片拖拽排序回归检查失败：');
  for (const [name] of failed) console.error(`- ${name}`);
  process.exit(1);
}
console.log('角色卡片拖拽排序回归检查通过');
