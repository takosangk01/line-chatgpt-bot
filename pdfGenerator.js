const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');

// ← 👇 タイトルを引数に追加
async function generatePDF(summary, advice, fileName, topPdfPath, title) {
  const outputDir = path.join(__dirname, 'output');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const tempPath = path.join(outputDir, `temp_${fileName}`);
  const finalPath = path.join(outputDir, fileName);

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

    // 👇 タイトルを引数から動的に出力
    doc.fontSize(18).text(title || '◆◆ あなただけの診断結果 ◆◆', { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(12).text(summary, { lineGap: 6 });
    doc.moveDown(1.5);

    doc.text(advice, { lineGap: 6 });

    doc.end();

    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  // Step 2: PDF合成
  const mergedPdf = await PDFLibDocument.create();

  const topPdfBytes = fs.readFileSync(topPdfPath);
  const topPdfDoc = await PDFLibDocument.load(topPdfBytes);
  const topPages = await mergedPdf.copyPages(topPdfDoc, topPdfDoc.getPageIndices());
  topPages.forEach(p => mergedPdf.addPage(p));

  const resultPdfBytes = fs.readFileSync(tempPath);
  const resultPdfDoc = await PDFLibDocument.load(resultPdfBytes);
  const resultPages = await mergedPdf.copyPages(resultPdfDoc, resultPdfDoc.getPageIndices());
  resultPages.forEach(p => mergedPdf.addPage(p));

  const mergedPdfBytes = await mergedPdf.save();
  fs.writeFileSync(finalPath, mergedPdfBytes);

  fs.unlinkSync(tempPath);

  return finalPath;
}

module.exports = { generatePDF };
