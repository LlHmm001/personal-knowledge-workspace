# PKW 检索评测与验收

更新：2026-10-02。本评测子任务交付的是**可运行的评测工具及验证**；工具不修改检索排序、不调用新的模型服务，也不证明真实资料检索质量提高。工程另已实现显式本地关键词降级和 Processing 不完整标志，本工具会保留这些范围差异。验证只使用本机合成数据和 loopback HTTP，未读取或上传用户语料，未请求生产 WeKnora。

工具：`scripts/evaluate-retrieval.mjs`。测试：`scripts/tests/retrieval-evaluation.test.mjs`。只使用 Node 内建模块，不新增依赖；现有 `pnpm test:tooling` / `pnpm test` 会通过测试文件通配符纳入它。

## 它回答什么

用户关心“应该找到的能否找到、不相关的会不会混进来、第一条是不是有用、找不到答案时能否诚实说明”。工具按一组人工判断的查询，对实际 RPC 返回顺序计算质量和时延，再逐题比较旧版本与候选版本。整体平均提高不能掩盖某个重要问题退化；报告不自动给出生产发布批准。

既有冻结规范保持：Main + Processing 的 A2 联合检索 → PKW业务对象合并 → active canonical过滤；WeKnora仍是投影，Note/Attachment仍是本地资料的稳定业务身份。见 [KNOWLEDGE_RETRIEVAL_DECISION.md](../KNOWLEDGE_RETRIEVAL_DECISION.md) 与 `packages/pkw/weknora-sync/src/index.ts:searchWithTrace/businessKey`。Main/Processing分数不可直接比较、现有相对门槛不足以保证相关性的限制仍存在；评测不利用score阈值重新解释结果。

评测身份与 `businessKey` 一致：

- Note → `note:<NoteId>`。
- 附件结果已有Companion Note → `note:<companionNoteId>`，与界面所打开的业务笔记一致。
- 没有Companion的本地附件结果 → `attachment:<AttachmentId>`。
- 仅有远端Knowledge/Chunk或无有效local映射 → `businessId:null`，占据原返回名次，计为不相关并单独报告；不以远端ID、路径或文件名伪造业务身份。
- 相同业务ID第二次出现仍占原名次，但不再得分。工具不会先删重/删未知结果再把后面的正确结果前移，以免掩盖实际用户所见的退化。

## 数据集格式

一个数据集绑定一个被授权访问的空间与一份语料快照。多人全空间联合搜索尚未实现时，不把不同空间的结果混在一次评分里。新增查询、改人工判断或改语料后，必须重新采集两边；工具核对整个数据集的SHA-256，拒绝拿不同判断集合比较。

```json
{
  "schemaVersion": 1,
  "datasetId": "synthetic-demo-v1",
  "evidenceKind": "synthetic",
  "corpusVersion": "synthetic-fixture-v1",
  "workspaceId": "test-workspace",
  "queries": [
    {
      "id": "q01",
      "query": "如何申请报销",
      "noAnswer": false,
      "judgmentsComplete": true,
      "judgments": [
        { "businessId": "note:note_expenses", "relevance": 3 },
        { "businessId": "note:note_finance", "relevance": 1 },
        { "businessId": "note:note_travel", "relevance": 0 }
      ]
    },
    {
      "id": "q02",
      "query": "合成资料中不存在的问题",
      "noAnswer": true,
      "judgmentsComplete": true,
      "judgments": []
    }
  ]
}
```

`evidenceKind`必须显式选择`synthetic`或`authorized-corpus`。后者仅是数据集来源声明，不代表工具已取得授权或证明采集无误。`corpusVersion`建议使用脱敏文件/业务ID清单的摘要，不能只写“最新”；ID必须来自这份语料。不得把凭据或整份配置写进版本标签。

相关性等级：0=无关，1=有帮助但不足以回答，2=相关且能部分回答，3=直接回答/关键资料。二值precision/recall/MRR把大于0视为相关；nDCG区分强弱。如果业务需要“必须直接回答”，应在冻结标注标准时说明，不在看到候选结果后临时调标准。

`noAnswer:true`要求没有任何正相关判断；有答案的查询至少有一项正相关。`judgmentsComplete:true`表示在所声明的语料快照里，相关资料判断已足够完整；否则填false，报告明确将recall/nDCG标为临时指标，未标注结果按0计分且单独计数。不能为得到更好的成绩把未知资料直接标成无关。

## 采集与接口

```sh
node scripts/evaluate-retrieval.mjs run \
  --dataset /absolute/evidence/queries.json \
  --endpoint http://127.0.0.1:3080/pkw/spaces/private/api \
  --run-id baseline \
  --code-version COMMIT_OR_ARTIFACT_SHA \
  --config-version NON_SECRET_CONFIG_DIGEST \
  --index-version INDEX_SNAPSHOT_ID \
  --headers-env PKW_EVAL_HEADERS \
  --limit 10 --timeout-ms 10000 \
  --out /absolute/evidence/baseline.run.json
```

`--endpoint`使用完整实际RPC路径，既兼容`/pkw/api`，也兼容后续`/pkw/spaces/<id>/api`。工具逐条发送：

```json
{ "method": "search", "args": { "query": "本条数据集问题", "limit": 10 } }
```

响应契约为`{ok:true,value:{results:[...],mode:"remote"|"local-keyword",trace:{...}}}`，结果使用现有`local.entityType/entityId/companionNoteId`。仅保存业务ID、排名、计数、模式/部分可用标志和耗时；不保存remote.content/snippet、查询正文、服务器原始报错、warning文本或凭据。trace白名单为`mainRaw/processingRaw/afterBusiness/afterCanonical/afterRelevance/final`六项非负计数，以及布尔`processingUnavailable`。服务端原有日志可能记录查询；真实样本前仍须检查目标日志政策。

每条观察保留`mode`与`partial`：完整远程响应记`remote/false`；远程且`trace.processingUnavailable=true`记`remote/true`；本地关键词记`local-keyword/true`；旧RPC未给模式或未知模式记`unknown/null`，不猜成远程成功。当前远程契约仅在Processing失败时给出true，未给该可选标志按“服务端未报告Processing故障”处理，不是独立远端健康证明。错误观察的模式/完整性在评分中为unknown/null，单独计失败。

本地关键词只查本空间笔记正文和附件文件名，不含附件内部全文或语义。`partial=true`表示当前结果不能代表完整远程检索范围；它可以是可用的降级结果，不必伪装成请求错误，但也不能冒充远程召回完整。既有schemaVersion=1的旧run仍可评分，缺模式会明确进入unknown。

默认仅允许localhost/127.0.0.1/::1。远端必须明确`--allow-remote`且为HTTPS，并先获得对该目标/语料的授权；本轮没有执行远端采集。端点禁止username/password、querystring和fragment；禁止跟随重定向，避免携带查询或会话跳到另一个目标。

需要登录时，由部署者在本机已授权环境中设置`PKW_EVAL_HEADERS`为请求头JSON（如Cookie及需要的CSRF头），命令只传**变量名**。工具没有`--token`或URL凭据入口，也不会输出该变量值。无鉴权的隔离合成服务可省略`--headers-env`。所有输出必须为新文件；写入使用0600权限，已存在输出会在发请求前拒绝，避免覆盖旧证据或重复产生检索成本。

run文件包含数据集摘要、语料/空间标识、runId、采集时间、limit、codeVersion/configVersion/indexVersion、每条queryId/status/mode/partial/latencyMs/hits及脱敏错误码。版本信息由操作者显式提供，**工具不会证明正在运行的服务器恰好是该版本**；实际安装包哈希、配置摘要与部署receipt必须配套核验，不能拿开发机HEAD替代服务器版本。

HTTP错误、RPC错误、无效JSON/结构、超时和传输失败分别保留为失败记录，不伪装成空搜索。超时覆盖响应body读取；单次响应上限8MiB。没有重试、上传、索引重建、自动调参或任何canonical写入。顺序执行以减少自造并发噪声；这是逐查询时延样本，不是15人并发容量测试。

## 离线评分与比较

```sh
node scripts/evaluate-retrieval.mjs evaluate \
  --dataset /absolute/evidence/queries.json \
  --run /absolute/evidence/baseline.run.json \
  --k 1,5,10 --out /absolute/evidence/baseline.report.json

node scripts/evaluate-retrieval.mjs compare \
  --dataset /absolute/evidence/queries.json \
  --baseline /absolute/evidence/baseline.run.json \
  --candidate /absolute/evidence/candidate.run.json \
  --k 1,5,10 --out /absolute/evidence/comparison.json
```

这两个命令完全离线，不请求RPC。两次run使用同一数据集及相同的评测cutoff；k不能大于任一run的请求limit。输出含每题变化，方向统一为`candidate − baseline`；质量与成功空结果通常越高越好，误召、错误和时延通常越低越好。报告不把“不显著变化”写成显著提升，也不自动把某个总分当发布门槛。

| 指标 | 精确定义与边界 |
| --- | --- |
| Precision@k | 前k名中的不重复相关业务对象数 / k；返回不足k也以k作分母 |
| Recall@k | 前k名不重复相关对象数 / 该查询所有正相关标注对象数 |
| MRR@k | 第一条相关对象若在前k，取1/原始名次，否则0；对有答案查询宏平均 |
| nDCG@k | 实际DCG / 理想DCG；每名gain=`2^relevance − 1`，折扣=`log2(rank+1)`；理想顺序按标注等级降序 |
| 无答案误召率 | 成功返回非空前k结果的无答案查询数 / 所有无答案查询数；未知ID也算返回了误召 |
| 无答案成功空结果率 | 成功返回空结果的无答案查询数 / 所有无答案查询数 |
| 无答案错误率 | 请求失败的无答案查询数 / 所有无答案查询数；以上三率相加为1，错误不能提高正确空结果率 |
| Query success rate | 成功RPC查询数 / 所有查询数；包括本地降级，并不表示完整远程成功。有答案查询失败时质量指标记0，不从分母悄悄去掉 |
| 检索范围比例 | `retrievalScope` 中completeRemote、remotePartial、localKeyword、unknownSuccess、failed的count/rate，以全部查询为分母，五类比例之和为1；另列partial与processingUnavailable比例（交叠诊断，不与五类相加） |
| 无答案空结果范围 | 原emptySuccessRate按RPC空结果计；另列完整远程、partial、未知范围空结果比例，分母均为全部无答案查询。三者相加为原空结果比例，降级或未知空结果不能当作完整无答案证据 |
| p50 / p95 / mean | 端到端请求耗时；分全部请求与成功请求。分位采用nearest rank；小样本p95不能冒充负载容量结论 |
| 诊断计数 | 重复ID、无本地映射、未标注业务ID按cutoff统计；不静默丢弃它们 |

无答案查询不参与precision/recall/MRR/nDCG的有答案宏平均；不存在相应查询群体时指标为null，不是0或100%。报告保留每题失败与标注完整性，因此必须同时看质量、可用性和无答案表现。

baseline/candidate比较同时给出模式比例变化与每题modeBefore/modeAfter、partialBefore/partialAfter；即使Recall和RPC成功率相同，从远程退回关键词也会明确显示。旧run的未知范围不填充成remote。两次运行模式分布不同时，先逐题按相同范围复核，不能把少搜索了附件而得到的低误召写成远程相关性提升。

CLI退出码：0=采集/计算完成且没有请求失败，可能全部是关键词降级；2=已写出报告，但有查询失败；1=输入/约束/文件写入错误。0**不等于完整远程成功或质量达标**。真实验收需审阅模式、partial、每题退化、重要样例、标注完整性及业务门槛。

## 本轮验证与真实质量门槛

已执行`node --test scripts/tests/retrieval-evaluation.test.mjs`，13项通过：手算指标、重复与未知结果原名次、无答案/失败分母、空结果与null群体、Companion身份、非法标注、版本约束、真实本机HTTP（空间路径/Cookie/超时/重定向）、目标限制、离线CLI保护，以及远程/partial/关键词/旧未知模式、比例分母和降级比较。这只证明工具在这些场景下计算和采集正确，**不证明WeKnora效果提升**。全仓总数由协调者统计，不与专项相加。

| Task | Status | Next step | Completion standard | Verification evidence | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 评测格式/采集/公式/比较 | 已实现；合成13项测试通过 | 纳入协调者完整工具测试 | 公式可手算；失败/重复/未知不抬分；模式与partial不掩盖；版本/数据集绑定 | 本文、脚本、Node测试 | 中 | 不修改检索排序或业务源码 |
| 真实baseline | 未执行 | 由用户/部署方提供经授权的脱敏查询、预期资料和目标快照 | 覆盖标题/罕见词/语义/附件内部句子/无答案；标注完整性明确 | 真实run/report与安装包/配置/索引receipt | 高 | 语料正文不传给新增第三方服务 |
| 候选质量比较 | 未执行；尚未实现新reranker | 冻结同一语料和判断后，采集候选 | 预先定义重要查询和容许退化；逐题核验，真实无答案误召下降不能以大幅漏召换取 | baseline/candidate比较、人工复核、成本/时延记录 | 高 | 不先设无依据的承诺分数 |
| 真实附件链路健康 | 待目标WeKnora证据 | 用已知附件内部句子检索并检查处理库日志/状态 | 解析产物可用、A2映射正确、正确业务Note可召回；故障有partial标志 | 检索金标准和远端证据 | 高 | 当前Processing异常会带processingUnavailable；RPC200或本地关键词结果仍不证明此链路健康 |

## 多人完整交付的独立依赖复核

已确认首批约15人，旧资料全部先保留在本人私人空间。完整交付须保留以下证据，不能由本评测工具或个人版功能测试代替：

1. **身份与权限**：真实身份提供方/登录入口、owner/admin/editor/viewer规则、会话撤销和CSRF；viewer直接调用写RPC、伪造workspace/身份、退出后的请求必须被服务端拒绝。验读、写、邀请、导出、清理与附件路径，而非仅隐藏按钮。
2. **两个私人空间 + 一个共享空间隔离**：使用同文件名、相似正文、不同ID及交错并发请求，证明canonical目录、结构化存储、cache、worker、附件字节、来源关系、搜索片段与日志不会串空间。当前已用独立runtime/SQLite实现并做本机集成，目标仍须验证；固定domain名称被独立上下文隔开，不能只拿workspace字段作为隔离证据。
3. **真实搜索边界**：正确绑定每空间Main/Processing投影；撤权后后续搜索、旧附件URL、缓存、导出领取均不可访问。工具可在各授权空间评分，但它不会替平台实施权限，也不能单靠无答案样本证明无泄漏。
4. **旧数据保留与回退**：目标服务器canonical/结构化状态/事件/配置/手改UI清单、备份可恢复性、NoteId/AttachmentId/TaskId/哈希/引用对账；先指定本人所有者，不能自动全员共享。迁移失败不切流量，回退不丢切换后的新写入、不重新开放已撤销成员。
5. **目标环境与运行证据**：宿主版本、当前存储schema、启动停止方式、真实WeKnora解析/检索配置和完整CI。真实手机和15人代表性并发样本分别验收；只有合成HTTP或浏览器改宽度仍不足。

鉴权/隔离/导入及协作整根恢复gate已有本机专项，最终包/浏览器由协调者收尾；真实目标清单、授权语料、当前备份与恢复环境仍须部署方提供并实际验证。协调者已报告本地15个合成账号的真实HTTP并发功能用例通过，它不是目标容量测试。源实现、本机、CI、目标部署、业务验收保持分层。当前状态见 [COLLABORATION_DESIGN.md](COLLABORATION_DESIGN.md)，部署路径见 [COLLABORATION_DEPLOYMENT.md](COLLABORATION_DEPLOYMENT.md)。
