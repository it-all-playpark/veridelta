# Changelog

## [0.9.0](https://github.com/it-all-playpark/veridelta/compare/v0.8.0...v0.9.0) (2026-08-02)


### Features

* **compare:** previous-superset baseline mode と series key を実装 ([6f9adba](https://github.com/it-all-playpark/veridelta/commit/6f9adbabea676c15d2520ed6a3e646b3310c1906))

## [0.8.0](https://github.com/it-all-playpark/veridelta/compare/v0.7.0...v0.8.0) (2026-08-02)


### Features

* **vitest:** selector-relation capability と subset comparability を実装 ([#64](https://github.com/it-all-playpark/veridelta/issues/64)) ([c0b58e5](https://github.com/it-all-playpark/veridelta/commit/c0b58e530f28b5f84a0c6843eb5148370e237a76))


### Bug Fixes

* **vitest-adapter:** treat --test-name-pattern kebab alias as scope-perturbing ([29a553c](https://github.com/it-all-playpark/veridelta/commit/29a553cbc4fa4f048ba372dfafb1769989069ab5))

## [0.7.0](https://github.com/it-all-playpark/veridelta/compare/v0.6.0...v0.7.0) (2026-08-02)


### Features

* **gate:** fail→flaky を verification_inconclusive として分類する（§12-1 B-inconclusive） ([839bddd](https://github.com/it-all-playpark/veridelta/commit/839bddd7af0c9606a51d82e20e476b3e68facecf))

## [0.6.0](https://github.com/it-all-playpark/veridelta/compare/v0.5.0...v0.6.0) (2026-07-31)


### Features

* **playwright:** Phase 2 の playwright-native/1 adapter を実装する ([f51aebe](https://github.com/it-all-playpark/veridelta/commit/f51aebe9740f0de56078d61f81875c4b72bab14b))

## [0.5.0](https://github.com/it-all-playpark/veridelta/compare/v0.4.0...v0.5.0) (2026-07-30)


### Features

* **schema:** instrument.capabilities を registry ではなく record へ載せる ([#49](https://github.com/it-all-playpark/veridelta/issues/49)) ([aedb4ba](https://github.com/it-all-playpark/veridelta/commit/aedb4ba2693efe12208e4b574327c49747f51ee1))

## [0.4.0](https://github.com/it-all-playpark/veridelta/compare/v0.3.1...v0.4.0) (2026-07-29)


### Features

* **vitest-adapter:** config_digest を9項目カバーに拡張し module_errors を構造化 ([d76aaf0](https://github.com/it-all-playpark/veridelta/commit/d76aaf0bd3f669c0765d31cf77e7efaa8eeb2146))

## [0.3.1](https://github.com/it-all-playpark/veridelta/compare/v0.3.0...v0.3.1) (2026-07-29)


### Bug Fixes

* **devflow:** dev-flow tooling の内部キャッシュを PR から除去 ([96b8f56](https://github.com/it-all-playpark/veridelta/commit/96b8f56f3d0fbf0079c49393245db49b24277026))
* **pr-43:** commit leftover review fixes (iteration 1) ([4ca0933](https://github.com/it-all-playpark/veridelta/commit/4ca093313619d9bbb2c063b5f87f7fea30ba101a))
* **render:** text report に completeness.status を表示する ([9e76bd3](https://github.com/it-all-playpark/veridelta/commit/9e76bd322604f9fe3231646f77bcd356c442803c))
* **test:** format completeness tests and cover partial baseline case ([e39ae1c](https://github.com/it-all-playpark/veridelta/commit/e39ae1c09b1f7601b67f660399b5e25d3ffe442f))

## [0.3.0](https://github.com/it-all-playpark/veridelta/compare/v0.2.2...v0.3.0) (2026-07-29)


### Features

* **adapter:** adapter seam を抽出し core から vitest 依存を切る ([e038e0b](https://github.com/it-all-playpark/veridelta/commit/e038e0b96c20e5f12f873b29583b8d398f6fb51e))
* **adapter:** adapter seam を抽出し core から vitest 依存を切る (Phase 1 Step 1) ([ac3442b](https://github.com/it-all-playpark/veridelta/commit/ac3442b5cef7f5af79b9cf802046c836e6e082d8))


### Bug Fixes

* **adapter:** 未検出の子にも capture チャネルを渡す / argv 注入を detect に限定 ([e478a0d](https://github.com/it-all-playpark/veridelta/commit/e478a0da8aeff04c55fea435916bcfeb596b7d91))

## [0.2.2](https://github.com/it-all-playpark/veridelta/compare/v0.2.1...v0.2.2) (2026-07-27)


### Bug Fixes

* **ci:** macOS の週次 full conformance 失敗を通知対象にする ([2c9264e](https://github.com/it-all-playpark/veridelta/commit/2c9264e11dbc615d3baf1b758d54b6e99c882771))
* **conformance:** add missing .gitignore to two base fixtures ([4fc2244](https://github.com/it-all-playpark/veridelta/commit/4fc2244c41117dd54584d9c5acec0430ef6a5da8))
* **recorder:** worktree外の実効config_sourcesをexternal接頭辞で記録 ([8276e3b](https://github.com/it-all-playpark/veridelta/commit/8276e3b09c953d2449873fba38c97e6295a1c30e))
* **windows:** normalize backslash paths in recorder key and lock error ([26157cd](https://github.com/it-all-playpark/veridelta/commit/26157cd6045bb3457f90571715f4fb01117ae7a2))

## [Unreleased]

### Changed

* **recorder:** vitest reporter が解決済みの `configFile`/`configFileDependencies` を Capture v2 経由で渡すようにし、recorder が worktree 相対パスまたは `external:` 接頭辞（worktree 外の実効設定）をキーとして `surface.config_sources` に digest 記録する方式へ変更

## [0.2.1](https://github.com/it-all-playpark/veridelta/compare/v0.2.0...v0.2.1) (2026-07-26)


### Bug Fixes

* **conformance:** fixtureワークスペースを祖先のvitest設定汚染から隔離 ([2b18572](https://github.com/it-all-playpark/veridelta/commit/2b18572bbb622e1c1fd8f00b4912267e6d6db3fa))

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
