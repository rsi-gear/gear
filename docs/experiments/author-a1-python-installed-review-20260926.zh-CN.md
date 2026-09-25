# A1 已安装 Python SDK 准入审计

结论：本切片可提交。新 helper 从用户指定的 Python 解释器发现已安装的 gear_algorithm，不回退到仓库 SDK；完整 host 调用点仍在接线。

主审发现原实现先 realpath 解释器再执行，会将常见 venv/bin/python 链接解析为基础 Python，丢失虚拟环境的 site-packages。已改为保留用户的绝对启动入口，并单独记录实际二进制摘要、Python 版本、prefix/basePrefix 和 pyvenv.cfg 摘要。SDK 身份限定为准确的 gear_algorithm 包目录；其他已加载模块和包环境仍由现有 worker 环境合同检查，不扫描整个 site-packages 作为 SDK 源树。

实施者类型检查通过，已安装 wheel 准入 1 项和 Python A0 13 项通过。主审在独立副本 /private/tmp/gear-python-installed-review.ryfx60_c 重跑两文件 14 项，全部通过，三个切片文件与 live 树逐字节一致。新测试现场构建本地 wheel、创建干净 venv、离线安装 wheel，并启动实际 Python author worker 读取封存声明；未使用仓库源码 PYTHONPATH 代替安装。worker 本地回环通信使用提升权限。

该结果证明 venv/安装准入可用，不代表完整外部搜索、真实模型或 Hitch 已通过。发现 helper 的身份需由通用宿主写入 run lock，下一切片验收。
