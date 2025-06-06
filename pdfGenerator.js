const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function generatePDF(summary, advice, fileName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const filePath = path.join(__dirname, 'output', fileName);
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    doc.font('Helvetica-Bold').fontSize(18).text('? ‚µ‚ë‚­‚Üf’fŒ‹‰Ê', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(summary, { lineGap: 4 });
    doc.moveDown();
    doc.text(advice, { lineGap: 4 });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

module.exports = { generatePDF };