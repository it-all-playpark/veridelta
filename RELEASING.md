# Releasing vdelta

`vdelta` を npm パッケージとして再現可能にリリースするための手順。以下の順に実施する。

## 1. Preconditions

- `main` ブランチにいること、working tree が clean であること:

  ```sh
  git checkout main
  git pull
  git status
  ```

- リリース対象の fix commit が `main` にマージ済みであることを確認する:

  ```sh
  git log --oneline
  ```

  対象 fix commit のハッシュが `main` の履歴（祖先）に含まれていることを目視で確認する。
  祖先関係を厳密に確認したい場合は `git merge-base --is-ancestor <fix-commit> main` を使う
  （終了コード 0 なら祖先）。

## 2. Version bump

- `package.json` の `version` と `package-lock.json` を同時に、原子的に更新する:

  ```sh
  npm version <patch|minor|major> --no-git-tag-version
  ```

  `--no-git-tag-version` を必ず付ける（このコマンド単体でタグ・コミットを作らせない。
  タグ付けは publish 後の手順4で行う）。

- `src` コード側のバージョン文字列は手動編集しない。`src/run.ts` は
  `createRequire(import.meta.url)('../package.json')` で `package.json` の `version` を
  実行時に単一ソースとして読み込む構成であり、`VDELTA_VERSION` は自動的に追随する。
  `tests/unit/version.test.ts` が `VDELTA_VERSION === package.json version` の一致を保証する。

- version bump は直接 `main` に push せず、通常の開発フローに従う: feature branch を切って
  `package.json` / `package-lock.json` の変更をコミット → PR 作成 → レビュー → `main` へマージ。

## 3. Publish

- `main` を最新化した状態で publish する:

  ```sh
  git checkout main
  git pull
  npm publish
  ```

  `prepublishOnly` フックが lint・build・test を自動実行し、publish 前のゲートとして機能する
  （これらが失敗すると publish は中断される）。npm は publish 時点の `HEAD` commit を
  パッケージの `gitHead` メタデータに自動記録する。

- publish 後、release tag を付与して push する:

  ```sh
  git tag v<X.Y.Z>
  git push origin v<X.Y.Z>
  ```

## 4. Post-publish verification

- 公開された version を確認する:

  ```sh
  npm view vdelta version
  ```

  新しい version（例: `0.1.1`）が返ることを確認する。

- 公開物が `main` 上の commit を指しており、対象 fix commit を祖先に含むことを確認する:

  ```sh
  npm view vdelta gitHead
  ```

  例えば 0.1.1 では、#9 の実 fix commit `907240f` が祖先であることを次のコマンドで確認する
  （終了コード 0 なら祖先関係が成立）:

  ```sh
  git merge-base --is-ancestor 907240f "$(npm view vdelta gitHead)"
  ```

## 5. Downstream propagation

- vdelta を利用する側のリポジトリ（例: skills repo）で依存を更新する:

  ```sh
  npm update vdelta
  ```

- 新しい version が反映されていることを確認する:

  ```sh
  node -p "require('vdelta/package.json').version"
  ```

  または:

  ```sh
  cat node_modules/vdelta/package.json
  ```

  の `version` フィールドを直接確認してもよい。

- 更新された lockfile（`package-lock.json` など）を commit する:

  ```sh
  git add package-lock.json
  git commit -m "chore: update vdelta to <X.Y.Z>"
  ```
