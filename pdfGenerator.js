const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function generatePDF(summary, advice, fileName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const outputDir = path.join(__dirname, 'output');

    // 出力フォルダが存在しない場合は作成
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    const filePath = path.join(outputDir, fileName);
    const stream = fs.createWriteStream(filePath);

    // 日本語フォントを登録（.ttf）
    const fontPath = path.join(__dirname, 'fonts', 'NotoSansJP-Regular.ttf');
    doc.registerFont('NotoSans', fontPath);
    doc.font('NotoSans');

    doc.pipe(stream);

    // タイトル
    doc.fontSize(18).text('🧸 あなただけの取扱説明書', { align: 'center' });
    doc.moveDown();

    // Summaryブロック
    doc.fontSize(12).text(summary, { lineGap: 4 });
    doc.moveDown();

    // アドバイス本文
    doc.text(advice, { lineGap: 4 });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

module.exports = { generatePDF };
