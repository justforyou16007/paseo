# Explored Environments Index

已配置过的运行环境记录。当 `/experiment-env-configuration` 配置新项目时，
先读取此索引，匹配相似环境的历史条目，复用已验证的配置模式以减少重复探索。

每次成功配置（Phase 6 promote 成功）后，Phase 6.5 自动在此目录下创建
`<project-slug>-env.md` 并在下表追加一行。

## How to Use

1. 配置开始时（Phase 4.5 步骤 3），读取此文件的 Entries 表
2. 按 Location + Dependency 列找最接近当前项目的条目
3. 读取对应的 `<project>-env.md` 参考文件
4. 用其中的 activation、verify_cmd、gotchas 作为 seed，减少探索

## Entries

| Project | Location | Dependency | Transfer | Launch | File | Date |
|---------|----------|------------|----------|--------|------|------|
