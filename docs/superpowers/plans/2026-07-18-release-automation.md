# vdelta リリース自動化 + downstream 自動追随 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** main へのマージから npm publish・消費側（skills / corporate-site）の依存更新までを、release-please の Release PR マージ 1 クリックに集約する。

**Architecture:** veridelta 側は release-please（Conventional Commits から version 算出、Release PR 常時維持、マージで tag + Release 作成）+ OIDC Trusted Publishing による publish workflow。消費側は Renovate の packageRule（`rangeStrategy: "bump"` + `automerge: true`）で vdelta のみ全 update type を CI green 条件付き自動マージし、常に最新へ追随する。

**Tech Stack:** googleapis/release-please-action@v4, npm Trusted Publishing (OIDC), Mend Renovate

## Global Constraints

- vdelta の `engines`: `node >=22`（Node 20 サポート終了済み）
- veridelta の commit は Conventional Commits（`ci:` / `docs:` はリリース非対象 type）
- tag 形式は既存の `vX.Y.Z` を維持（`include-component-in-tag: false`）
- 0.x の間は breaking change でも major に上げない（`bump-minor-pre-major: true`）
- main への直 push 禁止。全変更は feature branch → PR

---

### Task 1: veridelta — release-please 設定 + publish workflow

**Files:**
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`（現行 version `0.1.1` を起点に登録）
- Create: `.github/workflows/release-please.yml`

**Interfaces:**
- Produces: workflow 名 `release-please.yml`（npm Trusted Publisher 登録時にこのファイル名を指定する）、tag `vX.Y.Z`、GitHub Release

- [x] **Step 1: 設定 2 ファイルと workflow を作成**（内容は本リポジトリの実ファイル参照）
- [x] **Step 2: 構文検証** — `jq . release-please-config.json .release-please-manifest.json`（JSON OK）。actionlint は未導入のため PR CI / GitHub 側パースで担保

### Task 2: veridelta — RELEASING.md 更新 + PR

**Files:**
- Modify: `RELEASING.md`（手動 publish 手順 → 自動化フロー・失敗時リカバリ・初期設定メモに全面書き換え）

- [x] **Step 1: RELEASING.md 書き換え**
- [ ] **Step 2: コミット** — `ci:`（自動化 3 ファイル）と `docs:`（RELEASING.md + 本計画）に分割
- [ ] **Step 3: push + draft PR 作成**

### Task 3: skills — renovate.json + PR

**Files:**
- Create: `renovate.json`

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "timezone": "Asia/Tokyo",
  "packageRules": [
    {
      "matchPackageNames": ["vdelta"],
      "rangeStrategy": "bump",
      "matchUpdateTypes": ["major", "minor", "patch"],
      "automerge": true
    }
  ]
}
```

`rangeStrategy: "bump"` が必須: `^0.1.1` の range 内 patch（0.1.2 等）はデフォルトでは PR が立たず追随が止まるため。

- [ ] **Step 1: renovate.json 作成**
- [ ] **Step 2: 検証** — `npx --yes --package renovate renovate-config-validator renovate.json` → `INFO: Config validated successfully`
- [ ] **Step 3: branch `chore/renovate-vdelta-automerge` でコミット → push → draft PR**

### Task 4: corporate-site — renovate.json + CI Node bump + PR

**Files:**
- Create: `renovate.json`（Task 3 と同一内容）
- Modify: `.github/workflows/ci.yml` — `node-version: '20'` → `'22'`（vdelta の `engines >=22` に整合）

- [ ] **Step 1: renovate.json 作成 + ci.yml の node-version bump**
- [ ] **Step 2: 検証** — renovate-config-validator（Task 3 と同コマンド）
- [ ] **Step 3: branch `chore/renovate-vdelta-automerge` でコミット → push → draft PR**

### Task 5: 検証 + 一回だけの手動設定（ユーザー作業）

- [ ] Renovate app 導入状況の確認（`gh search prs --author "app/renovate"`、sandbox で不可なら手動確認を依頼）
- [ ] ユーザー: npmjs.com で `vdelta` に Trusted Publisher 登録（GitHub Actions / `it-all-playpark/veridelta` / `release-please.yml`）
- [ ] ユーザー: veridelta repo settings で "Allow GitHub Actions to create and approve pull requests" を ON
- [ ] ユーザー: Renovate app を skills / corporate-site に有効化（未導入なら）
- [ ] ユーザー: （branch protection で CI 必須の場合のみ）PAT を `RELEASE_PLEASE_TOKEN` secret に登録
- [ ] 一巡テスト: 3 PR マージ後、`fix:` を main に入れる → Release PR → マージ → `npm view vdelta version` 更新 → 消費側に Renovate PR → automerge

**スコープ外（YAGNI）:** publish 直後の `repository_dispatch` による即時伝播（Renovate の周期で十分）、ローカル inner loop（`npm link` で従来通り）
