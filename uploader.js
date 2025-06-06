const cloudinary = require('cloudinary').v2;
const path = require('path');

cloudinary.config({
  secure: true, 
});

async function uploadPDF(filePath) {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'auto',
    folder: 'shirokuma_reports',
    use_filename: true,
    unique_filename: false,
    overwrite: true
  });
  return result.secure_url;
}

module.exports = { uploadPDF };
