import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  Param,
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

  // Subir a la cuenta de Cloudinary cuesta plata y el borrado es irreversible:
  // ambos quedan detras del guard, para office/admin. El preset toca la
  // configuracion de la cuenta, asi que es solo admin.
  @Post('upload-image')
  @Auth(ValidRoles.OFFICE, ValidRoles.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.cloudinaryService.uploadFile(file);
  }

  @Post('upload-preset')
  @Auth(ValidRoles.ADMIN)
  uploadPreset() {
    return this.cloudinaryService.uploadPreset();
  }

  @Delete('delete/:id')
  @Auth(ValidRoles.OFFICE, ValidRoles.ADMIN)
  remove(@Param('id') id: string) {
    return this.cloudinaryService.deleteImage(id);
  }
}
