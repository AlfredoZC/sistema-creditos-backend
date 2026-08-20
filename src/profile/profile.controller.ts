import {
  Controller,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  // Sin guard, cualquier anonimo podia pisar la foto de cualquier perfil
  // pasando su id. La subida self-service del propio paciente/doctor llega
  // con los portales, donde se agrega el chequeo de propiedad.
  @Patch('upload-profile-image/:id')
  @Auth(ValidRoles.OFFICE, ValidRoles.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  uploadProfileImage(
    @UploadedFile() file: Express.Multer.File,
    @Param('id') id: number,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    return this.profileService.uploadProfileImage(file, id, updateProfileDto);
  }

  @Delete('delete-image/:profileId')
  @Auth(ValidRoles.OFFICE, ValidRoles.ADMIN)
  DeleteProfileImage(@Param('profileId') id: string) {
    return this.profileService.deleteProfileImage(id);
  }
}
