# svgview

`svgview` は、SVGファイルをローカルブラウザでプレビューするためのCLIツールです。
ファイル保存時の自動更新と、過去に開いたSVGのローカルライブラリ保存に対応しています。

## 機能

- `svgview <file.svg>` でSVGをローカルブラウザに表示します。
- SVG保存時の変更を `fs.watch` で検知し、Server-Sent Eventsでブラウザへ更新通知します。
- 一度開いたSVGを `~/.svgview/library` にコピー保存します。
- メタデータを `~/.svgview/index.json` に保存します。
- 引数なしの `svgview` でライブラリ一覧画面を開きます。
- ライブラリ内のSVGをタイル状に並べ、サイドパネルから選択したSVGへ自動フォーカスします。
- 外部通信は行いません。
- ランタイム依存パッケージはありません。

## ローカル開発でのインストール

```sh
npm link
```

その後、次のように実行できます。

```sh
svgview architecture.svg
```

## 使い方

```sh
svgview <file.svg>
svgview
svgview <file.svg> --port 4321
svgview <file.svg> --no-open
svgview <file.svg> --foreground
svgview --stop
```

サーバーは `127.0.0.1` のみにバインドします。

### バックグラウンド起動

`svgview` はデフォルトでバックグラウンド起動します。

```sh
svgview architecture.svg
```

バックグラウンドサーバーを停止する場合:

```sh
svgview --stop
```

バックグラウンド起動時のPIDとログは次に保存されます。

```text
~/.svgview/server.pid
~/.svgview/server.log
```

ターミナル上で前面実行したい場合は `--foreground` を使います。

```sh
svgview architecture.svg --foreground
```

すでにバックグラウンドサーバーが起動している状態で別のSVGを指定すると、既存サーバーを停止して新しいSVGで起動し直します。引数なしの `svgview` は、起動中のビューアを開きます。

## HTTP API

- `GET /`: ビューアHTMLを返します。
- `GET /svg`: 現在プレビュー中のSVGを返します。対象がない場合は `204` を返します。
- `GET /library`: 保存済みSVGのメタデータ一覧をJSONで返します。レスポンスには `currentId` と `items` が含まれます。
- `GET /library/:id`: 保存済みSVGを返します。
- `GET /events`: SSEストリームを開き、監視中のSVGが変更されたら `reload` イベントを送ります。

## セキュリティ上の注意

`svgview` のサーバーは `127.0.0.1` のみにバインドし、外部公開はされません。
一方で、`~/.svgview/library` に取り込んだSVGをブラウザで別タブとして直接開いた場合、SVG内の `<script>` が `127.0.0.1` のオリジンで実行され得ます。ライブラリには信頼できるSVGのみを取り込んでください。

## 保存データ

SVGファイルの保存先:

```text
~/.svgview/library
```

インデックスファイル:

```text
~/.svgview/index.json
```

例:

```json
{
  "items": [
    {
      "id": "20260518-143210-abc123",
      "name": "architecture.svg",
      "storedPath": "library/20260518-143210-abc123.svg",
      "sourcePath": "/absolute/path/to/architecture.svg",
      "createdAt": "2026-05-18T14:32:10.000Z",
      "updatedAt": "2026-05-18T14:32:10.000Z",
      "size": 48213
    }
  ]
}
```

## 開発

```sh
npm run check
```
# svgview-cli
