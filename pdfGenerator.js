const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function generatePDF(summary, advice, fileName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const outputDir = path.join(__dirname, 'output');

    // 出力フォルダがなければ作成
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filePath = path.join(outputDir, fileName);
    const stream = fs.createWriteStream(filePath);

    // 日本語フォントのパス
    const fontPath = path.join(__dirname, 'fonts', 'NotoSansJP-Regular.ttf');
    if (!fs.existsSync(fontPath)) {
      return reject(new Error('フォントファイルが見つかりません: ' + fontPath));
    }

    doc.registerFont('NotoSans', fontPath);
    doc.font('NotoSans');

    doc.pipe(stream);

    // タイトル
    doc.fontSize(18).text('🧸 あなただけのトータル診断', { align: 'center' });
    doc.moveDown(1.5);

    // Summary
    doc.fontSize(12).text(summary, { lineGap: 6 });
    doc.moveDown(1.5);

    // Advice
    doc.text(advice, { lineGap: 6 });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

module.exports = { generatePDF };
