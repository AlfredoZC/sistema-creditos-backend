import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { UserRole } from '../common/enums';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { handleDatabaseError } from '../common/errors';
import { normalizePhone } from '../whatsapp/phone-normalizer';
import { CreateDoctorDto } from './dto/create-doctor.dto';
import { UpdateDoctorDto } from './dto/update-doctor.dto';
import { Doctor } from './entities/doctor.entity';

@Injectable()
export class DoctorsService {
  constructor(
    @InjectRepository(Doctor)
    private readonly doctorRepository: Repository<Doctor>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * T8 transactional create: every doctor must have a web account, so the
   * users row (role doctor, bcrypt password) and the doctors row are inserted
   * in ONE transaction. When the DTO provides an existing userId, the doctor
   * row links to that account instead and the account role is upgraded to
   * doctor. A professional license or phone duplicate rolls back the users row
   * with the doctors row (23505 -> 409, nothing persisted — AD5).
   */
  async create(createDoctorDto: CreateDoctorDto): Promise<Doctor> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        let userId: string;
        if (createDoctorDto.userId) {
          const user = await manager.findOne(User, {
            where: { id: createDoctorDto.userId },
          });
          if (!user) throw new NotFoundException('User not found');
          user.role = UserRole.DOCTOR;
          await manager.save(user);
          userId = user.id;
        } else {
          if (
            !createDoctorDto.name ||
            !createDoctorDto.email ||
            !createDoctorDto.password
          ) {
            throw new BadRequestException(
              'name, email and password are required when no userId is provided',
            );
          }
          const user = manager.create(User, {
            name: createDoctorDto.name,
            email: createDoctorDto.email,
            password: bcrypt.hashSync(createDoctorDto.password, 10),
            role: UserRole.DOCTOR,
          });
          userId = (await manager.save(user)).id;
        }

        const doctor = manager.create(Doctor, {
          userId,
          specialty: createDoctorDto.specialty,
          professionalLicense: createDoctorDto.professionalLicense,
          firstName: createDoctorDto.firstName,
          paternalLastName: createDoctorDto.paternalLastName,
          maternalLastName: createDoctorDto.maternalLastName ?? null,
          phone: normalizePhone(createDoctorDto.phone),
        });
        return manager.save(doctor);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;
    const [data, total] = await this.doctorRepository.findAndCount({
      take: limit,
      skip: offset,
      relations: ['user'],
    });
    return { data, total, limit, offset };
  }

  async findOne(id: string, currentUser: User): Promise<Doctor> {
    const doctor = await this.doctorRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!doctor) throw new NotFoundException('Doctor not found');
    this.assertOwnRecordOrStaff(doctor, currentUser);
    return doctor;
  }

  async update(
    id: string,
    updateDoctorDto: UpdateDoctorDto,
    currentUser: User,
  ): Promise<Doctor> {
    try {
      const doctor = await this.doctorRepository.findOne({ where: { id } });
      if (!doctor) throw new NotFoundException('Doctor not found');
      this.assertOwnRecordOrStaff(doctor, currentUser);
      if (updateDoctorDto.phone !== undefined) {
        (updateDoctorDto as UpdateDoctorDto).phone = normalizePhone(
          updateDoctorDto.phone,
        );
      }
      Object.assign(doctor, updateDoctorDto);
      return await this.doctorRepository.save(doctor);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  private assertOwnRecordOrStaff(doctor: Doctor, currentUser: User): void {
    if (
      currentUser.role === UserRole.DOCTOR &&
      doctor.userId !== currentUser.id
    ) {
      throw new ForbiddenException('Doctors can only access their own record');
    }
  }
}
