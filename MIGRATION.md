# 迁移指南 · 从 v1（`dsh-mobile-bridge`）到 v2（`dsh-pocket-plugin`）

**一句话：没有自动迁移。** 本项目里没有任何读取旧目录或旧格式的代码——全仓搜索 `mobile-bridge` 命中 0 处，`lib/` 只认自己的数据目录。所以设备、口令、房间密钥都要在 v2 里**重新建立**；旧的东西留在原地不动即可。

好消息是重做一遍只要几分钟：重设口令 → 重开配对页 → 手机重新扫码。

## 对照表

| | v1 | v2（本包） |
| --- | --- | --- |
| 包名 | `dsh-mobile-bridge` | `dsh-pocket-plugin`（插件 `name: 'dsh-pocket'`） |
| 数据目录 | `~/.dsh/mobile-bridge` | `$DSH_HOME/pocket`（默认 `~/.dsh/pocket`） |
| 中继协议 | 1（旧版） | 2（`lib/cloud.mjs:38`） |
| 局域网桥协议 | 1 | 1（`lib/util.mjs:17`） |
| 默认端口 | 47901 | 47901 |
| 口令 | v1 的 `auth.json` | v2 的 `auth.json`，**需重设** |
| 设备令牌 / 二维码 | v1 下的 token | v2 重新配对后新发 |
| 房间号 / 房间密钥 | v1 的 `cloud.json` | v2 重新生成（`lib/cloud-service.mjs`） |

> 数据目录以代码为准：`resolvePaths()` 在没显式配置 `dataDir` 时取 `path.join(home, 'pocket')`，`home` 默认是 `$DSH_HOME`，再缺省为 `~/.dsh`（`lib/core.mjs:43-59`）。如果你在 v1 里手写过 `dataDir`，v2 不会继承，需要自己再写一次。
>
> v1 那一列的细节来自旧版发布信息，**不在本仓库内**，无法在这里逐行核对；它的作用只是说明差异方向。v2 那一列全部可在代码中查到。

## 不会迁移的四样东西

1. **数据目录**——v2 只读写 `$DSH_HOME/pocket`，不读 `~/.dsh/mobile-bridge`。
2. **房间号与房间密钥**——存在 v2 自己的 `cloud.json` 里，首次启动远程时新生成。旧二维码立即作废。
3. **设备令牌**——v2 的 `state.json` 只存哈希，没有"导入旧哈希"的入口；手机端必须重新配对。
4. **访问口令**——v2 的 `auth.json` 需要你重新设一次。

**不要手工把 v1 的文件复制进 `pocket/`。** 那是未经测试的路径：本项目不校验旧文件的结构，也不为混用产生的后果负责。真要在旧机器上留着历史记录，就留着 v1 目录当存档。

## 迁移步骤

前置：Node.js ≥ 22.15；宿主（DSH）能正常启动；手机和电脑在同一 Wi-Fi（局域网配对阶段用）。

1. **备份并保留 v1 目录。**

   ```bash
   # 只复制，不移动、不删除
   cp -a ~/.dsh/mobile-bridge ~/.dsh/mobile-bridge.bak
   ```

   Windows 上等价操作：在资源管理器里复制 `%USERPROFILE%\.dsh\mobile-bridge` 整个文件夹，或 `robocopy` 到 `.bak` 目录。

   v2 不会碰这个目录，留着它就是你的回滚材料。

2. **停掉 v1 的插件行。** 编辑 profile 的补丁文件 `$DSH_HOME/profiles/<你的 profile>/cordis.patch.yml`，删掉（或注释掉）`name: 'dsh-mobile-bridge'` 那一行。**必须先停 v1 再起 v2**：两者默认都想绑 47901，v2 发现被占用会顺延（最多试 16 个端口，`lib/server.mjs:145-152`），于是"电脑上开的 47901/pair"可能是 v1 的页面，你会以为配对码失效了。

3. **安装 v2。**

   ```bash
   dsh plugin add /path/to/dsh-pocket
   ```

   它会把依赖写进 profile 的 `package.json`，并把 `cordis.patch.yml` 里 `- insert:` 那一段插进 profile 的补丁文件。手写安装也可以：把本包 `cordis.patch.yml` 的 `- insert:` 整段复制过去，`name:` 改成插件 `lib/index.mjs` 的路径。

4. **设访问口令**（远程路径的唯一闸门；不设则中继不会启动）。

   ```bash
   node tools/set-auth.mjs --user 你的名字
   ```

   交互输入，不回显、不进命令历史，最少 8 位。若你在插件配置里写了自定义 `dataDir`，加 `--data <那个目录>`，否则它会写到默认的 `$DSH_HOME/pocket`。

5. **配置 `cloud.appBase`。** 本包的默认值是空字符串 `''`（`lib/cloud.mjs:107`），**空 = 远程不启动**，配对页的「远程」一栏会显示 `未配置`。填你自己托管的手机端外壳地址：

   ```bash
   node tools/build-shell.mjs     # 生成 docs/
   # 把 docs/ 发布到你的静态托管，然后把 appBase 指向它
   ```

   嫌麻烦可以先用局域网路径，`cloud.appBase` 留空即可，不影响局域网。

6. **重启 DSH 宿主。** 插件是 ESM，代码级改动必须冷启动；只改配置才热重载。重启后打开 `http://127.0.0.1:47901/pair`（端口被占就看 `/api/v1/health` 返回的 `port`）。

7. **手机重新配对。** 扫码或手输配对码（形如 `VX42-9NWA`，10 分钟有效、最多 10 次，一台电脑最多 8 台设备）。局域网和远程各扫一次，两个码不通用。

8. **清掉手机上的旧外壳。** 旧的主屏幕图标指向旧外壳缓存（Service Worker），它可能还在用 v1 的协议跟 v2 说话，表现为"一直转圈"或"登录失败"。做法：在手机浏览器里删除该站点的数据 / 移除旧主屏幕图标，再从新链接重新添加。

## 验证清单

```bash
node bin/cli.mjs status     # 端口、任务数、设备数、中继状态
node bin/cli.mjs devices    # 应该只看到刚配对的新设备
node bin/cli.mjs link       # 打印二维码 + 配对链接 + 配对码
```

浏览器打开 `http://127.0.0.1:<port>/api/v1/health`，应返回 `ok: true`、`version: 1.0.0`、`protocol: 1`（这里的 `protocol` 是局域网桥协议，不是中继协议）。远程那一栏：`未配置` = `appBase` 为空；`已阻止` = 没有口令；`连接失败` = broker 不通。

手机侧验三件事：能看到会话列表、能新建一个任务、能中断它。

## 回滚

v1 目录没被碰过，所以回滚只有三步：

1. **先停 v2**，确认 47901 上没有任何东西在听（否则 v1 也会顺延，而旧手机里存的是 `http://<IP>:47901`）。
2. **把 profile 补丁里那一行改回 v1**：删掉 `dsh-pocket` 那行，恢复 `dsh-mobile-bridge` 那行原始配置。
3. **重启宿主。**

v1 的 `auth.json` / `state.json` / `cloud.json` 都还在 `~/.dsh/mobile-bridge`，旧手机上的令牌也因此继续有效——**这是回滚路径，不是正常路径**：只要 v2 还在跑，就不要让 v1 和 v2 共用同一个端口区间。

`$DSH_HOME/pocket` 目录可以留着（不占地方、也不会影响 v1），确认不再需要时再删。

## 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 配对页显示的是旧界面 | v1 还在 47901，v2 顺延到了 47902 | 停 v1，或看 `/api/v1/health` 的 `port` |
| 手机一直转圈 / 登录失败 | 手机上还是 v1 的外壳缓存 | 删站点数据，用新链接重新加主屏幕 |
| 配对页「远程」显示 `未配置` | `cloud.appBase` 是空字符串 | 自托管 `docs/` 后填地址；只局域网用可不管 |
| 「远程」显示 `已阻止` | 没有 `auth.json` | `node tools/set-auth.mjs --user 你的名字` |
| 手机提示口令错误，但口令没错 | 改过口令会让所有旧会话失效 | 重新登录；或确认登录的是 v2 的配对页 |
| 任务创建报 `cwd_forbidden` | `allowedRoots` 为空 = 全部禁止（不是全开） | 先在桌面端打开一个工作区，或填 `allowedRoots` |
| `set-auth.mjs` 写到了别处 | 配置里自定义了 `dataDir` | 加 `--data <目录>` |

## 兼容性说明

v2 不提供 v1 的互通层：本包的中继帧协议是 2（见上表），状态变更帧必须带 `seq` / `ts` / `sid` 才会被接受（`lib/cloud.mjs:774-790`），缺字段一律按过期帧拒绝。因此：

- 旧外壳（v1 的 `appBase`）连不上 v2，必须换成用本包 `tools/build-shell.mjs` 生成的产物。
- 旧二维码、旧设备令牌、旧口令一律不再有意义。
- 局域网桥协议仍是 1，但两端 UI 是一起发布的，不存在"只升级一边"的场景。
