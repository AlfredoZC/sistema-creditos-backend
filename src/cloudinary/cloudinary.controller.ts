import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  Patch,
  Param,
  Body,
  Delete,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CloudinaryService } from './cloudinary.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { Auth } from '../auth/decorators/auth.decorator';
import { ValidRoles } from '../auth/interfaces/valid-roles';

@ApiTags('Cloud')
@Controller('cloud')
export class CloudinaryController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  @Post('upload-image')
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    console.log(file);
    return this.cloudinaryService.uploadFile(file);
  }

  // @Auth(ValidRoles.admin)
  @Post('upload-preset')
  uploadPreset() {
    return this.cloudinaryService.uploadPreset();
  }

  @Delete('delete/:id')
  remove(@Param('id') id: string) {
    return this.cloudinaryService.deleteImage(id);
  }
}
