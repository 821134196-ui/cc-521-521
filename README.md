# 酒店加床管理

按 **房型规则、消防核准人数、折叠床库存** 受理加床申请，房务员配送 **床架 / 被褥 / 枕头**，住客确认后计入房账，退房逐件回收、检查损耗并结算。零第三方依赖，仅用 Node.js ≥ 22 内置的 `node:sqlite`、`http` 与测试运行器。

## 一条命令启动

```bash
npm start                 # 等价：node src/server.js
# 想清空演示数据重来：
npm run reset             # 重置 SQLite 后启动（node src/server.js --reset）
```

打开 http://localhost:5210 （端口可用 `PORT=xxxx npm start` 覆盖）。

**超员样例**：`301` 标准大床房已住满消防核准 2/2 人，在房态页对它申请加床会被拒并提示「入住人数超限」，原报价仍随申请留存。另有 `302` 房自带一张「住客已确认」的在租加床，可直接体验退房回收结算。

数据：
- SQLite：`data/hotel.db`（资源占用、订单、资产、结算、模拟房账）
- 验收 / 回收照片：本地 `data/photos/`
- 房账：`src/folio.js` 的**模拟适配器**（`post/list` 两方法，可替换为真实 PMS）

## 业务规则

| 场景 | 处理 |
| --- | --- |
| 入住人数超限 | `registered_guests + 加床 > 消防核准` → 拒绝 `occupancy`，记录原报价 |
| 房间空间不足 | 在租加床 + 申请 > 房型 `max_extra_beds` → 拒绝 `space` |
| 折叠床/布草不足 | 床架、被褥、枕头任一库存不足 → 拒绝 `stock`；派单事务内复查 |
| 床架分配不可重叠 | 借用以 `UPDATE ... WHERE status='available'` 原子抢占，一件资产只属一个订单 |
| 双人同时抢单 | 同一 `UPDATE ... WHERE status='dispatched'`，`changes===1` 才算成功，另一人收到 `already_claimed` |
| 床架损坏 | 收损坏费，床架置 `damaged` 不回可用库；**房务员无权自行减免**，须前台 |
| 跨夜续住 | 按确认→回收的实际过夜数计费，超过计划夜数标记「跨夜续住」 |
| 提前撤床 | 按实际过夜数（至少 1 晚）计费 |
| 退房漏收布草 | 被褥/枕头逐件标记缺件并**必填原因**，按价赔偿；资产置 `missing` |
| 前台调价 | 另存 `adjusted_total` 与原因，**原报价 `original_quote_total` 不被覆盖**，差额计入房账 |

赔偿标准（元）：床架损坏 800 / 遗失 1200；被褥污损 120 / 遗失 300；枕头污损 40 / 遗失 100。见 `src/store.js` 顶部 `FEES`。

## 三个界面

1. **房态列表**：每房直接显示「已加床 n / 空间上限」，以及入住/消防核准人数、可用库存条；此处受理加床申请，拒绝原因清楚可读。
2. **配送派单**：配送单按 **床架 / 被褥 / 枕头分项核对**；房务员抢单、上传送达验收照片、住客确认。
3. **退房回收**：借出清单与回收结论逐件对照（完好 / 损坏 / 缺件 + 原因 + 照片），实时汇总跨夜床位费与缺件赔偿，结算后前台可在保留原报价的前提下调价。

配色为酒店白、深绿与温和金色，金额使用等宽数字、缺件原因高亮。

## HTTP 接口

`GET /api/rooms|room-types|staff|assets|stock|applications|orders`、`GET /api/orders/:id`、`GET /api/rooms/:id/folio`；
`POST /api/apply`、`/api/dispatch`、`/api/orders/:id/claim|deliver|confirm|settle|adjust`。结算支持 `settled_at`（ISO 时间）用于精确演示跨夜 / 提前撤床。

## 测试

```bash
npm test
```

20 个用例（`node:test`，内存 SQLite）覆盖：

- **容量限制**：超员、空间不足、库存不足三类拒绝；
- **库存竞争**：床架不重叠、并发抢占下派单失败且资产不串单、两名房务员抢单仅一人成功（含真实 HTTP 并发）；
- **跨夜费用**：跨夜续住按实际夜数、提前撤床按 1 晚；
- **缺件结算**：漏收被褥/枕头赔偿、床架损坏不回库、房务员减免被拒、前台减免上限、调价保留原报价、完好件回收后可再派单；
- 另含验收照片本地落盘与取回、房态已加床数量等 HTTP 集成用例。

## 目录

```
src/
  db.js      SQLite 连接与表结构
  store.js   全部业务规则与事务（容量/库存/抢单/确认/回收结算/调价）
  folio.js   模拟房账适配器
  seed.js    房型、库存、房态、员工演示数据（含超员样例）
  server.js  零依赖 HTTP 服务、JSON API、本地照片存取
public/      三页前端（index.html / style.css / app.js）
test/        store.test.js（单元）、http.test.js（HTTP 集成）
```
