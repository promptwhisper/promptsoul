# Third-Party Notices

PromptSoul 的 MIT License 只覆盖本仓库中版权持有人有权许可的代码和文档。它不授予下列第三方模型、SDK、图片或其他素材的权利。

## Upstream project

PromptSoul 基于 [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui) 扩展。上游原创部分由 Yuki Shindo 按 MIT License 授权；根目录 [LICENSE](LICENSE) 保留其版权声明和 MIT 条款。

## Live2D Hiyori sample data

- Hiyori 模型数据不包含在 Git 仓库中，也不受 PromptSoul 的 MIT License 覆盖。
- 下载和使用前必须阅读并接受 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 与 [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/)。
- Hiyori 的角色设计不得修改。包含该角色的截图或演示必须在画面内保留 `Hiyori Momose ©Live2D` 及适用条款要求的声明。

## Live2D Cubism Core

浏览器从 Live2D 官方 CDN 加载 Cubism Core，仓库不再分发其字节。该 SDK 受 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 约束。公开或商业发布前，请自行确认是否还需要 Live2D 的 Publication License 或其他授权。

## Browser libraries

浏览器运行时按固定 URL 和 SRI 加载：

- [PixiJS 6.5.10](https://github.com/pixijs/pixijs), MIT License
- [pixi-live2d-display 0.4.0](https://github.com/guansss/pixi-live2d-display), MIT License

Node.js 依赖及精确版本记录在 `package-lock.json` 中，并继续受各自许可证约束。

## Community standards

`CODE_OF_CONDUCT.md` 是对 [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) 的简化改写。Contributor Covenant 原版按 [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) 许可。

## User-supplied assets and providers

用户导入的 Live2D 模型、纹理、语音、提示词、Provider 输出和其他素材不会因为进入本地 PromptSoul 工作区而变成 MIT 授权内容。使用者有责任确认自己拥有处理、展示和发布这些内容的权利，并遵守所连接 AI Provider 的条款与隐私政策。
