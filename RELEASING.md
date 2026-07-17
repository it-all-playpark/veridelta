# Releasing vdelta

`vdelta` のリリースは release-please + npm Trusted Publishing で自動化されている。
日常の手作業は **Release PR をマージするだけ**。

## リリースフロー

1. 通常どおり Conventional Commits（`feat:` / `fix:` / `feat!:` など）で開発し、PR を `main` にマージする。
2. `main` に releasable な commit（`feat:` / `fix:` / breaking change）が積まれると、
   release-please が **Release PR** を自動作成・更新する。この PR には次が含まれる:
   - `package.json` / `package-lock.json` の version bump
     （Conventional Commits から自動算出。0.x の間は breaking change でも minor bump: `bump-minor-pre-major`）
   - `CHANGELOG.md` の更新
3. リリースしたいタイミングで Release PR をマージする。これをトリガーに自動で:
   - `vX.Y.Z` tag と GitHub Release が作成される
   - publish job が `npm ci && npm publish` を実行する
     （`prepublishOnly` フックが lint → build → test を publish 前ゲートとして実行。
     認証は npm Trusted Publishing（OIDC）で、トークンの手動管理は不要）

`ci:` / `docs:` / `chore:` などの type はリリース対象外なので、Release PR の version には影響しない。

`src` 側のバージョン文字列は手動編集不要。`src/run.ts` は `package.json` の `version` を
実行時に単一ソースとして読み込む構成で、`tests/unit/version.test.ts` が一致を保証する。

## 検証

publish 後に確認する場合:

```sh
npm view vdelta version   # 新しい version が返ること
npm view vdelta gitHead   # main 上の release commit を指すこと
```

対象 fix commit が公開物に含まれることを厳密に確認したい場合
（終了コード 0 なら祖先関係が成立）:

```sh
git merge-base --is-ancestor <fix-commit> "$(npm view vdelta gitHead)"
```

## publish job が失敗したとき

- **Trusted Publisher 未設定 / 認証エラー**: npmjs.com の `vdelta` → Settings → Trusted Publisher に
  GitHub Actions（repo: `it-all-playpark/veridelta`, workflow: `release-please.yml`）が
  登録されているか確認し、登録後に失敗した job を re-run する。
- **`prepublishOnly`（lint / build / test）失敗**: 原因を修正して `main` にマージ後、job を re-run する。
- tag と GitHub Release は publish より先に作成されるが、re-run は安全
  （同一 version の二重 publish は npm レジストリ側で拒否される）。

## 一回だけの初期設定（メンテナ向けメモ）

- npmjs.com: `vdelta` に Trusted Publisher を登録（GitHub Actions / `it-all-playpark/veridelta` / `release-please.yml`）
- GitHub repo settings → Actions → General: "Allow GitHub Actions to create and approve pull requests" を ON
  （release-please が Release PR を作成するために必要）
- `main` の branch protection で CI チェックを必須にしている場合:
  fine-grained PAT（contents / pull-requests: write）を `RELEASE_PLEASE_TOKEN` secret に登録する。
  `GITHUB_TOKEN` が作成した PR には CI がトリガーされないという GitHub の制約のため。
  workflow は `RELEASE_PLEASE_TOKEN` があればそれを使い、なければ `github.token` にフォールバックする。

## Downstream への伝播

vdelta を利用するリポジトリ（skills / corporate-site）には Renovate が設定されており、
新しい version の publish 後、自動で依存 bump PR が作成され CI green で automerge される。
手動で即時更新したい場合は各リポジトリで:

```sh
npm update vdelta
git add package.json package-lock.json
git commit -m "chore: update vdelta to <X.Y.Z>"
```
