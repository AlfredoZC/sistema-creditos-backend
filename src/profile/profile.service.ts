import { CloudinaryService } from './../cloudinary/cloudinary.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { DataSource, Repository } from 'typeorm';
import { Profile } from './entities/profile.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { v2 as cloudinary } from 'cloudinary';

@Injectable()
export class ProfileService {
  constructor(
    @InjectRepository(Profile)
    private readonly profileRepository: Repository<Profile>,
    private readonly cloudinaryService: CloudinaryService,
    private readonly dataSource: DataSource,
  ) {}

  async uploadProfileImage(
    file: Express.Multer.File,
    id: number,
    updateProfileDto: UpdateProfileDto,
  ) {
    try {
      if (updateProfileDto) {
        await this.dataSource
          .createQueryBuilder()
          .update(Profile)
          .set(updateProfileDto)
          .where('id = :id', { id })
          .execute();
      }

      const profile = await this.profileRepository.findOneBy({ id });

      if (!file) {
        return profile;
      }

      const { secureUrl, publicId } = await this.cloudinaryService.uploadFile(
        file,
      );

      if (secureUrl) {
        await this.dataSource
          .createQueryBuilder()
          .update(Profile)
          .set({ photo: secureUrl, photoPublicId: publicId })
          .where('id = :id', { id })
          .execute();
      }

      return await this.profileRepository.findOneBy({ id });
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  async deleteProfileImage(id: string) {
    let profile;
    try {
      profile = await this.profileRepository
        .createQueryBuilder('profile')
        .where('profile.id = :id', { id })
        .getOne();

      await cloudinary.uploader.destroy(profile.photoPublicId);

      this.deletePhoto(id);

      return `The image was removed from cloudinary`;
    } catch (error) {
      console.log(error);
      if (error.http_code === 404) throw new NotFoundException();
      throw new BadRequestException(`The image doesn't exist`);
    }
  }

  private async deletePhoto(id: string) {
    await this.dataSource
      .createQueryBuilder()
      .update(Profile)
      .set({ photo: '', photoPublicId: '' })
      .where('id = :id', { id })
      .execute();
  }
}
