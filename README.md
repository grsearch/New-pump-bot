# Dump Sniper

## Pump.fun Graduation Discovery

The service discovers successful Pump.fun graduations without a webhook:

- Helius WebSocket logs provide the low-latency path; the migration wallet is polled every 5 seconds to fill gaps.
- A transaction is accepted only when it contains the official Pump `migrate` discriminator and targets the official PumpSwap program.
- Mint, pool, vaults, chain `blockTime`, slot, and signature are read from the confirmed transaction and saved in `tokens`.
- All token sources use the same market thresholds: FDV `$15,000-$1,000,000` and liquidity at least `$3,000`.
- Pump graduation admission checks only FDV and liquidity. It records the confirmed migration time and does not request or filter on mint creation age.
- Passing discovery only adds the token to monitoring. The Activity Flow buy strategy remains unchanged.

Configuration is under `PUMP_DISCOVERY_*` in `.env.example`. Set `PUMP_DISCOVERY_ENABLED=false` to disable it.

Monitoring-list FDV, LP, price, and 24h volume are refreshed every minute through
the batched DEX Screener token endpoint, with Birdeye as a fallback. The dashboard
shows the age and source of the last successful market refresh. Webhooks may send
`migrationTime`/`migration_time` (seconds, milliseconds, or ISO time); when an
older webhook row has no migration time, the selected DEX pair creation time is
used to backfill its migration AGE even when that pair does not yet expose complete
FDV/LP data. Legacy `WATCHDOG_CHECK_INTERVAL_MS` values above one minute are clamped
to `60000`.

Solana / Pump.fun 短线交易机器人。当前默认买入策略是 **15 秒资金流加速度反转**。

## 当前买入策略

每个监控代币收到实时 swap 后，程序使用已完成的 15 秒资金流窗口判断：

- 1 分钟总成交量默认必须达到 `$3,000`，按 `SOL_PRICE_USD` 换算成 SOL。`.env.example` 默认 `SOL_PRICE_USD=72`，所以约等于 `41.7 SOL/分钟`。
- 1 分钟交易次数默认必须 `>=25`，过滤低频小量币。
- 每个 15 秒窗口的净资金流为 `买入 SOL - 卖出 SOL`；相邻净资金流的差值作为资金流加速度。
- 最近 `3` 个完整 15 秒窗口的净资金流必须严格递增。
- 最近一次资金流加速度必须从负数变为正数。
- 价格涨跌和 K 线方向不参与买入判断。
- 买卖比过滤全部删除；买卖比仍可记录到特征库用于分析，但不会阻止买入。
- 同一个已完成 15 秒窗口最多产生一次信号，避免重复买入。
- 池子 SOL 默认仍需 `>=30 SOL`。
- 信号必须足够新，默认 `ACTIVITY_FLOW_MAX_SIGNAL_AGE_MS=5000`。

默认入口日志应显示：

```text
Entry: ACTIVITY_FLOW (FLOW_ACCEL_15S: 1m volume>=...SOL (~$3000), 3 increasing closed 15s net-flow values, flow acceleration - to +, ratio filters disabled)
Legacy dumpSignal: suppressed
[main] ActivityFlow enabled: mode=FLOW_ACCEL_15S ...
```

## 当前卖出策略

- 资金流退出：连续 `2` 个完整 15 秒窗口的净资金流从正数变为负数时卖出，价格涨跌不参与判断。
- 为避免使用入场前数据，卖出判断只使用买入后完整形成的 15 秒资金流窗口。
- 移动止盈：上涨 `20%` 激活，从最高点回撤 `10%` 卖出。
- 固定止盈：上涨 `100%` 立即卖出。
- 固定止损：下跌 `20%` 立即卖出。
- RSI 买卖过滤和 RSI 退出均关闭。
- TIMEOUT 卖出：关闭。
- 加仓：关闭。
- 卖出冷静期：实际平仓完成后，同币 `5 分钟` 内禁止再次买入；多仓分批卖出时从最后一笔完成卖出重新计时。

## 监控列表过滤

TokenWatchdog 默认每 1 分钟巡检一次 FDV 和 LP：

- FDV 必须在 `$15,000 ~ $1,000,000`
- Birdeye LP 必须 `>= $3,000`
- 24h 交易量必须 `>= $5,000`
- AGE 继续从 Pump 迁移时间开始计算并保存到特征库，但不参与监控列表过滤或移除
- 迁移时间未知时 AGE 显示未知，不使用 mint 创建时间或添加时间猜测
- 监控列表上限默认 `500` 个；只有新增代币后超过该上限才会触发驱逐

## 数据留存

默认开启 `SWAP_EVENT_LOG_ENABLED=true`。程序会把每一笔已解析的监控币实时 swap 写入 SQLite 的 `swap_events` 表，后续可以基于这张表离线重算窗口并回测阈值。

## Strategy Lab

默认开启 `STRATEGY_LAB_ENABLED=true`。程序会基于实时 `swapParsed` 成交流写入一套特征数据库：

- `token_snapshots`：最近活跃代币的每秒特征快照，包含 FDV、LP、AGE、买卖量/次数、唯一钱包、新/老买家、最大/平均/中位买单、BUY/SELL streak、TPS、价格变化、波动率、LP/FDV 变化、机器人延迟，以及延迟回填的 30s/60s/180s 未来收益标签。
- `token_candles`：15 秒和 1 分钟 K 线，包含 OHLC、买卖量、交易次数和唯一买卖钱包。
- `token_events`：首次突破 1 分钟高点、资金流转正、Buy Burst、TPS 翻倍、Smart Wallet 买入、LP 变化和 FDV 档位突破等事件。
- `bot_latency_events`：买入链路的 detect / decision / send / confirm 延迟拆分。

成交事件默认经过 `SwapSanitizer`：零成交量事件会被拒绝；CPI/余额回退产生的归一化价格、瞬时百倍跳价会使用最近可信池价或新鲜市场价校正。真实成交量仍会保留；暂时无法确定价格时只记录成交量，不生成价格 Tick。新数据写入 `data_quality_version=2`，原有历史行保持版本 1，便于明确区分修复前后的数据。

默认只给最近有成交的代币持续快照，避免全监控列表每秒刷库影响交易延迟。若要强制整个监控列表每秒记录，设置 `STRATEGY_LAB_SNAPSHOT_ALL_ACTIVE=true`。

导出策略数据集：

```bash
npm run export:strategy -- --hours 168
npm run export:strategy -- --hours 0 --all
```

默认只导出 `data_quality_version>=4`、价格可信且 30s/60s/180s 标签完整的样本。导出前会拒绝未确认的 2x 价格尖峰；超过 120 秒的成交断档会切断价格序列，30 秒内被后续 3 笔可信成交确认的新价格会作为真实跳变保留。需要导出未打标签快照时可加 `--include-unlabeled`。`--all` 会校验导出字段数确实等于数据库全部特征字段。只有明确研究旧数据时才使用 `--min-quality-version 0`。

## 15 秒策略回测

积累真实 `swap_events` 后运行：

```bash
npm run backtest:flow-candles
```

回测默认读取最近 7 天，按当前买入、资金流卖出、固定止盈、移动止盈和固定止损规则模拟，并扣除 `2%` 往返执行成本。可通过 `BT_SINCE_MS`、`BT_UNTIL_MS`、`BT_ROUND_TRIP_COST_PCT`、`BT_MIN_VOLUME_1M_SOL` 和 `BT_MIN_TRADES_1M` 调整研究范围。

至少积累 3 到 7 天、`10,000` 笔以上有效 swap 和 30 笔以上已平仓模拟交易后，再判断胜率和收益；样本更少时只能视为探索性结果。

## 关键配置

```env
ACTIVITY_FLOW_ENABLED=true
ACTIVITY_FLOW_REPLACE_DUMP_SIGNAL=true
ACTIVITY_FLOW_ENTRY_MODE=FLOW_ACCEL_15S
ACTIVITY_FLOW_1M_MIN_VOLUME_USD=3000
ACTIVITY_FLOW_1M_MIN_VOLUME_SOL=
ACTIVITY_FLOW_1M_MIN_TRADES=25
ACTIVITY_FLOW_COOLDOWN_MS=0
ACTIVITY_FLOW_MIN_POOL_QUOTE_SOL=30
ACTIVITY_FLOW_MAX_SIGNAL_AGE_MS=5000

FLOW_REVERSAL_EXIT_ENABLED=true
FLOW_REVERSAL_EXIT_MODE=FLOW_TURN_15S

TRAILING_ACTIVATE_PCT=20
TRAILING_DRAWDOWN_PCT=10
TAKE_PROFIT_PCT=100
RSI_1M_EXIT_ENABLED=false
RSI_1M_EXIT_THRESHOLD=80
FIXED_STOP_LOSS_PCT=-20
EMERGENCY_STOP_LOSS_PCT=0
STABILIZATION_EMERGENCY_DRAWDOWN_PCT=0
MAX_HOLD_MS=0

ADDON_ENABLED=0
ADDON_DROP_PCT=20

REBUY_COOLDOWN_MS=300000
MIN_FDV_USD=15000
MAX_FDV_USD=1000000
MIN_LIQUIDITY_USD=3000
WATCHDOG_CHECK_INTERVAL_MS=60000
WATCHDOG_MARKET_STALE_MS=180000
MAX_MINT_AGE_HOURS=0
NEW_COIN_AGE_THRESHOLD_MS=0
MAX_WATCHED_TOKENS=500

BUY_MIN_PRIORITY_FEE_LAMPORTS=500000
BUY_CAP_PRIORITY_FEE_LAMPORTS=500000
BUY_MAX_PRIORITY_FEE_LAMPORTS=500000
MAX_PRIORITY_FEE_LAMPORTS=500000
SWAP_EVENT_LOG_ENABLED=true
STRATEGY_LAB_ENABLED=true
STRATEGY_LAB_SNAPSHOT_INTERVAL_MS=1000
STRATEGY_LAB_LABEL_ENABLED=true
STRATEGY_LAB_SNAPSHOT_ALL_ACTIVE=false
STRATEGY_LAB_BUY_BURST_THRESHOLD=10
STRATEGY_LAB_TPS_DOUBLE_MIN=5
STRATEGY_LAB_LP_CHANGE_PCT=10
```

上线前核对 `.env` 已填好 Helius、Birdeye 和钱包密钥，并确认启动日志显示 `FLOW_ACCEL_15S`。
