# Changelog

## [0.2.0](https://github.com/it-all-playpark/veridelta/compare/v0.1.1...v0.2.0) (2026-07-17)


### Features

* **store:** 保存済みrunの保持ポリシー(gc)を追加 ([723b0e0](https://github.com/it-all-playpark/veridelta/commit/723b0e0fcee8217111dc37933d5a2672e3ff6062))


### Bug Fixes

* **cli-io:** writeAllが非EPIPEの書き込みエラーを握り潰す問題を修正 ([422b06d](https://github.com/it-all-playpark/veridelta/commit/422b06d53340e12a4b3e175d352690c04478ea6f))
* **cli:** 終了前にstdout/stderrの書き込み完了を待機する ([dbc5253](https://github.com/it-all-playpark/veridelta/commit/dbc525303ad84e75a802b55982295373414107f8))
* **run:** baselineをGC後に評価せずrunAndRecordの比較後にGCを移動 ([3cd11a4](https://github.com/it-all-playpark/veridelta/commit/3cd11a483dd5c6a53f1fdb3cbd0c45f5568a0712))
* **run:** vitestの`--flag value`形式のセレクタ誤認識を修正 ([0022508](https://github.com/it-all-playpark/veridelta/commit/0022508354eec8a689c3248ce17f0a0cefe63980))
* **store:** atomically reclaim stale lock and surface reclaim events ([09de673](https://github.com/it-all-playpark/veridelta/commit/09de6737e24638eb4d3f592aba1f58dab7b4a9c4))
* **store:** stale advisory lock の検出と復旧 ([da5ccb3](https://github.com/it-all-playpark/veridelta/commit/da5ccb3cb6dd66c2744e6c9051d9437758e0b5a9))
* **store:** stale advisory lockをPID生存確認で自動復旧する ([c06d19d](https://github.com/it-all-playpark/veridelta/commit/c06d19d3c050671d4c5c6d3350f6799945d4fa59)), closes [#13](https://github.com/it-all-playpark/veridelta/issues/13)
