import { v2 as cloudinary } from 'cloudinary';

export const CloudinaryProvider = {
  provide: 'CLOUDINARY',
  useFactory: () => {
    return cloudinary.config({
      cloud_name: process.env.CLOUD_NAME_CLOUDINARY,
      api_key: process.env.API_KEY_CLOUDINARY,
      api_secret: process.env.API_SECRET_CLOUDINARY,
    });
  },
};