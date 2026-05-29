#!/bin/bash
set -e

# medical サイト (medical.snishi-code.com / medical-dev.snishi-code.com) のビルド。
# Cloudflare Pages の build command に `bash build.sh` を指定し、出力ディレクトリは
# リポジトリルート (.) を指す。
#
#   - hospital-rounds/ を単一HTMLにビルドし、ソースをビルド成果物 (dist) で置き換える
#     → <origin>/hospital-rounds/ で配信
#   - ルートの index.html (医療ランディング) / shared.css / site-links.js は静的配信
#   - docs/ は Obsidian vault (説明書の元ネタ) なので配信物には含めない

cd hospital-rounds
npm install
npm run build
cd ..

# hospital-rounds/ のソースをビルド成果物で置換
cp -r hospital-rounds/dist _hr_built
rm -rf hospital-rounds
mv _hr_built hospital-rounds

# Obsidian vault は公開デプロイに含めない
rm -rf docs

echo "Build complete (medical)."
