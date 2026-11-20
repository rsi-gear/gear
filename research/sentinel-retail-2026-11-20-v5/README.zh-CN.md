# Retail V5 记录复核工具

**此目录目前只包含离线复核工具，不是已完成的三组效果报告。** V5 使用冻结源码 `c032ab44a`、固定 LLM 权重和 CPU retail 工具；不做 GPU 训练。完整实验仍须取得各组生成、搜索与封存后的测试结果，才能判断是否可比。

`records.py` 导出已经写入 `result.json` 的采集或生成记录，也接受正式 provider 中共享调用存储的完整 sample。步数耗尽的采集结果可以导出，但仍保持 `incomplete / passed=null`。没有封存结果的运行前缀不能导出为完整记录。

导出时检查原始 pending、request、receipt 摘要及调用键，随后移除 SDK thread／turn 标识。复核从新建的 CPU 数据库重放全部原始模型回答，核对工具返回、完整轨迹、校准、评分和 token 汇总。复核不加载 SDK，也不提交模型请求。语义审核仍使用当时的模型判断，不能称为新的独立语义裁判。

```bash
/path/to/tau2-python records.py --repository /path/to/frozen-c032ab44a \
  capture --workspace /path/to/sealed-sample --output /path/to/archive

/path/to/tau2-python records.py --repository /path/to/frozen-c032ab44a \
  verify --archive /path/to/archive --tau2-source /path/to/pinned-tau2
```

采集记录可增加 `--negative-checks`，检查篡改原生回答、请求指令、工具返回、评分和 usage 后能否被拒绝。此选项需要样本实际执行过工具，且至少一次调用具有原生 usage。文件摘要用于检出归档变化，不提供外部签名认证。

复核源码必须与记录绑定的实现一致。主开发分支后续修正的结束提示与不完整搜索处理不会回写 V5，也不能用来改变 V5 的原始结果。完整实验归档完成前，本工具不承担组间收益、测试封存顺序或全局成本的验收。
