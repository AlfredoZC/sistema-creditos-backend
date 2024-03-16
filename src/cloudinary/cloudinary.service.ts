import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary';

@Injectable()
export class CloudinaryService {
  constructor(private readonly configService: ConfigService) {}

  async uploadFile(
    file: Express.Multer.File,
  ): Promise<{ secureUrl: string; publicId: string }> {
    return new Promise<{ secureUrl: string; publicId: string }>(
      (resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            { upload_preset: this.configService.get('CLOUDINARY_PRESET') },
            (
              error: any,
              uploadResult: UploadApiResponse | UploadApiErrorResponse,
            ) => {
              if (error) {
                console.log('Error uploading to Cloudinary:', error);
                reject(
                  new BadRequestException(`Upload failed: ${error.message}`),
                );
              } else {
                console.log(
                  'Uploaded to Cloudinary successfully:',
                  uploadResult.public_id,
                );
                resolve({
                  secureUrl: uploadResult.secure_url,
                  publicId: uploadResult.public_id,
                });
              }
            },
          )
          .end(file.buffer);
      },
    );
  }

  async uploadPreset() {
    cloudinary.api
      .create_upload_preset({
        name: 'preset-nestj',
        tags: 'employees, faces, profile',
        unsigned: false,
        auto_tagging: 0.75,
        folder: this.configService.get('FOLDER_CLOUDINARY'),
        allowed_formats: 'jpg, png, jpeg',

        transformation: [
          {
            width: 200,
            height: 200,
            crop: 'thumb',
            gravity: 'face',
          },
        ],
      })
      .then((result) => console.log(result));
  }

  async deleteImage(id: string): Promise<string> {
    try {
      await cloudinary.uploader.destroy(id);
      return `The image with the id: ${id} was removed from cloudinary`;
    } catch (error) {
      throw new NotFoundException('The image could not be deleted.');
    }
  }
}
