# 钉钉企业登录配置

本服务用于同一企业的人事登记。普通浏览器访问使用钉钉官方网页 OAuth 登录；后端使用现有企业内部应用的通讯录接口核验员工身份。**无需填写或核对 CorpId。**

## 1. 选择现有企业内部应用

访问 [钉钉开发者后台](https://open-dev.dingtalk.com/)，切换到你们企业，在「应用开发」中打开当前用于 AI 表格回传的企业内部应用。继续使用本项目 `.env` 中的 `DINGTALK_APP_KEY` 和 `DINGTALK_APP_SECRET`；不要发到聊天或提交到 GitHub。

本方案需要企业内部应用拥有的本企业通讯录访问权限；不能用个人应用或第三方应用的凭据直接替换。

## 2. 配置网页 OAuth 回调

在应用的「安全设置 → 重定向 URL」，或部分后台版本中的「钉钉登录与分享／登录配置」，添加完整回调地址：

```text
https://test.example.com/auth/dingtalk/callback
```

地址的协议、域名、路径要完全一致，不要只填域名，不要额外加结尾 `/`。网页应用首页可设为：

```text
https://test.example.com/
```

花生壳域名变更时，后台回调与 `.env` 的 PUBLIC_ORIGIN 都要更新。

## 3. 申请权限和员工范围

在应用「权限管理」中，检查以下能力：

| 用途 | 接口/权限 |
| --- | --- |
| 获取登录用户身份 | 用户委托权限 `Contact.User.Read`，调用 `GET /v1.0/contact/users/me` |
| 查询本企业员工映射 | `POST /topapi/user/getbyunionid` |
| 确认员工有效且身份匹配 | `POST /topapi/v2/user/get`，通常归于通讯录成员信息读取权限 |
| 原有测评表格回传 | 保留已有 AI 表格读取、写入权限 |

后两项按后台接口详情对应的权限申请，以当前开放平台列出的权限为准。可见/使用范围及通讯录授权范围需要包含允许登记的人事员工；不必为了联调读取无关组织的信息。

本次已用现有应用对当前表格操作人进行了只读查询：unionId 能查到 userid，用户详情返回 active=true，身份匹配。这说明现有应用的上述通讯录接口已能调用；其他员工仍受已配置范围约束。

若后台提示需要审批或发布版本，按其要求完成后权限才生效。用户身份权限和已有表格写权限是不同的权限，写表成功不代表网页 OAuth 已配置完成。

## 4. 检查服务配置并重建

```dotenv
PUBLIC_ORIGIN=https://test.example.com
ADDITIONAL_ORIGINS=http://localhost:8082,http://127.0.0.1:8082
COOKIE_SECURE=true
HR_PORTAL_ENABLED=true
```

已有五项 DINGTALK 配置继续保留，不需要 DINGTALK_CORP_ID。更新 `.env` 后执行：

```bash
docker compose up -d --build
```

## 5. 登录核验流程

1. 访问服务首页，系统检查后端登录会话；有效会话可直接显示登记表。
2. 无会话时显示简洁登录卡片，点击「点击前往钉钉登录」，在当前页面进入钉钉官方账号/扫码授权页面；授权完成后自动返回登记表。
3. OAuth 使用 `scope=openid`；回调严格核对绑定当前浏览器的 state，授权码只在后端交换访问凭证。
4. 后端获取登录用户 unionId，再用当前企业内部应用凭据查询本企业 userid 和员工详情。
5. 查不到、不是内部员工、用户未激活或身份不匹配时拒绝登录。
6. 会话有效期12小时，常规查询最多缓存5分钟企业核验；每次生成邀请都会重新核验员工身份。退出会使后端会话立即失效。

不是按前端传来的企业名称、CorpId 或登录缓存布尔值放行。人事登录会话与来访者测评会话分开，相关 Cookie 和邀请标识不会转发给原站。

## 文档参考

- [浏览器用户授权流程](https://open-dingtalk.github.io/developerpedia/docs/develop/permission/token/browser/get_user_app_token_browser/)
- [实现网页方式登录应用](https://open.dingtalk.com/document/orgapp/tutorial-obtaining-user-personal-information)
- [获取登录用户的访问凭证](https://open.dingtalk.com/document/orgapp/obtain-identity-credentials)

用户提供的[第三方企业网页应用免登](https://open.dingtalk.com/document/development/web-applications-h5)适用于相应 H5 免登场景。当前入口是普通浏览器网站，使用上述网页 OAuth 流程；不要求用户必须在钉钉客户端里打开。
