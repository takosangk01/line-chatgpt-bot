const cloudinary = require('cloudinary').v2;
const path = require('path');

cloudinary.config({
  secure: true,
});

async function uploadPDF(filePath) {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: 'raw',            
      folder: 'shirokuma_reports',     
      use_filename: true,             
      unique_filename: false,         
      overwrite: true,                   
      type: 'upload'                   
    });

    return result.secure_url;
  } catch (error) {
    console.error('❌ Cloudinary upload error:', error);
    throw error;
  }
}

module.exports = { uploadPDF };
