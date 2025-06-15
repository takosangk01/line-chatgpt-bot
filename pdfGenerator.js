const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');

async function generatePDF(summary, advice, fileName, topPdfPath) {
  const outputDir = path.join(__dirname, 'output');

  // 出力フォルダがなければ作成
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const tempPath = path.join(outputDir, `temp_${fileName}`);
  const finalPath = path.join(outputDir, fileName);

  // 日本語フォントのパス
  const fontPath = path.join(__dirname, 'fonts', 'NotoSansJP-Regular.ttf');
  if (!fs.existsSync(fontPath)) {
    throw new Error('フォントファイルが見つかりません: ' + fontPath);
  }

  // Step 1: ChatGPT出力部分のPDFを一時生成
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(tempPath);

    doc.registerFont('NotoSans', fontPath);
    doc.font('NotoSans');

    doc.pipe(stream);

    doc.fontSize(18).text('🧸 あなただけのトータル診断', { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(12).text(summary, { lineGap: 6 });
    doc.moveDown(1.5);

    doc.text(advice, { lineGap: 6 });

    doc.end();

    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  // Step 2: topページPDF + 上記PDF を合成
  const mergedPdf = await PDFLibDocument.create();

  // shindan01-top.pdf を読み込み
  const topPdfBytes = fs.readFileSync(topPdfPath);
  const topPdfDoc = await PDFLibDocument.load(topPdfBytes);
  const topPages = await mergedPdf.copyPages(topPdfDoc, topPdfDoc.getPageIndices());
  topPages.forEach(p => mergedPdf.addPage(p));

  // temp診断PDFを読み込み
  const resultPdfBytes = fs.readFileSync(tempPath);
  const resultPdfDoc = await PDFLibDocument.load(resultPdfBytes);
  const resultPages = await mergedPdf.copyPages(resultPdfDoc, resultPdfDoc.getPageIndices());
  resultPages.forEach(p => mergedPdf.addPage(p));

  // 保存
  const mergedPdfBytes = await mergedPdf.save();
  fs.writeFileSync(finalPath, mergedPdfBytes);

  // 一時ファイル削除（任意）
  fs.unlinkSync(tempPath);

  return finalPath;
}

module.exports = { generatePDF };
