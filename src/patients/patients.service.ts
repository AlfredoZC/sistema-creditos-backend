import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { UserRole } from '../common/enums';
import { handleDatabaseError } from '../common/errors';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { normalizePhone } from '../whatsapp/phone-normalizer';
import { CreatePatientDto } from './dto/create-patient.dto';
import { LinkUserDto } from './dto/link-user.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { Patient } from './entities/patient.entity';

@Injectable()
export class PatientsService {
  constructor(
    @InjectRepository(Patient)
    private readonly patientRepository: Repository<Patient>,
    private readonly dataSource: DataSource,
  ) {}

  async create(createPatientDto: CreatePatientDto): Promise<Patient> {
    try {
      // Canonical Phone Format: the DTO stays a plain string; normalization
      // happens here at the service boundary (design §6).
      const patient = this.patientRepository.create({
        ...createPatientDto,
        phone: normalizePhone(createPatientDto.phone),
      });
      return await this.patientRepository.save(patient);
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;
    const [data, total] = await this.patientRepository.findAndCount({
      take: limit,
      skip: offset,
    });
    return { data, total, limit, offset };
  }

  async findOne(id: string, currentUser: User): Promise<Patient> {
    const patient = await this.patientRepository.findOne({ where: { id } });
    if (!patient) throw new NotFoundException('Patient not found');
    this.assertOwnRecordOrStaff(patient, currentUser);
    return patient;
  }

  async update(
    id: string,
    updatePatientDto: UpdatePatientDto,
    currentUser: User,
  ): Promise<Patient> {
    try {
      const patient = await this.patientRepository.findOne({ where: { id } });
      if (!patient) throw new NotFoundException('Patient not found');
      this.assertOwnRecordOrStaff(patient, currentUser);
      Object.assign(patient, updatePatientDto);
      // Canonical Phone Format at the service boundary: normalize only when a
      // phone is actually provided for update.
      if (updatePatientDto.phone !== undefined) {
        patient.phone = normalizePhone(updatePatientDto.phone);
      }
      return await this.patientRepository.save(patient);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * T9 transactional link: binds the patient to an existing web account.
   * Explicit pre-checks (patient exists, not already linked, user exists)
   * run inside the transaction so a conflict rolls back everything; the
   * uq_patients_user_id constraint catches a user already linked to another
   * patient (23505 -> 409, nothing persisted).
   */
  async linkUser(id: string, linkUserDto: LinkUserDto): Promise<Patient> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const patient = await manager.findOne(Patient, { where: { id } });
        if (!patient) throw new NotFoundException('Patient not found');
        if (patient.userId) {
          throw new ConflictException('Patient already has a linked user');
        }

        const user = await manager.findOne(User, {
          where: { id: linkUserDto.userId },
        });
        if (!user) throw new NotFoundException('User not found');

        patient.userId = linkUserDto.userId;
        return manager.save(patient);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  private assertOwnRecordOrStaff(patient: Patient, currentUser: User): void {
    if (
      currentUser.role === UserRole.PATIENT &&
      patient.userId !== currentUser.id
    ) {
      throw new ForbiddenException('Patients can only access their own record');
    }
  }
}
