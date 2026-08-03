import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User } from '../auth/entities/user.entity';
import { SurgeryDoctorRole } from '../common/enums';
import { handleDatabaseError } from '../common/errors';
import { Doctor } from '../doctors/entities/doctor.entity';
import { Patient } from '../patients/entities/patient.entity';
import { SurgeryCatalog } from '../surgery-catalog/entities/surgery-catalog.entity';
import {
  AssignDoctorDto,
  CreateSurgeryDto,
  ReassignPrincipalDto,
  UpdateSurgeryDto,
  UpdateSurgeryStatusDto,
} from './dto';
import { Surgery, SurgeryDoctor } from './entities';

const AUDIT_ACTION_STATUS_CHANGED = 'surgery.status_changed';
const AUDIT_TABLE_SURGERIES = 'surgeries';

@Injectable()
export class SurgeriesService {
  constructor(
    @InjectRepository(Surgery)
    private readonly surgeryRepository: Repository<Surgery>,
    @InjectRepository(SurgeryDoctor)
    private readonly surgeryDoctorRepository: Repository<SurgeryDoctor>,
    @InjectRepository(SurgeryCatalog)
    private readonly surgeryCatalogRepository: Repository<SurgeryCatalog>,
    @InjectRepository(Patient)
    private readonly patientRepository: Repository<Patient>,
    @InjectRepository(Doctor)
    private readonly doctorRepository: Repository<Doctor>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  /**
   * D2: totalCost defaults to the catalog entry's base cost; the office may
   * override it per patient. Single-statement insert, no explicit transaction
   * needed (design section 8).
   */
  async create(createSurgeryDto: CreateSurgeryDto): Promise<Surgery> {
    try {
      const patient = await this.patientRepository.findOne({
        where: { id: createSurgeryDto.patientId },
      });
      if (!patient) throw new NotFoundException('Patient not found');
      const catalog = await this.surgeryCatalogRepository.findOne({
        where: { id: createSurgeryDto.surgeryCatalogId },
      });
      if (!catalog) throw new NotFoundException('Catalog entry not found');

      const surgery = this.surgeryRepository.create({
        patientId: createSurgeryDto.patientId,
        surgeryCatalogId: createSurgeryDto.surgeryCatalogId,
        scheduledDate: createSurgeryDto.scheduledDate,
        totalCost: createSurgeryDto.totalCost ?? catalog.baseCost,
        notes: createSurgeryDto.notes ?? null,
      });
      return await this.surgeryRepository.save(surgery);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * D2 guard: once a payment_plans row exists for the surgery, editing
   * total_cost is rejected with 409 (the plan's financed_amount derives from
   * it and would desync). The PaymentPlan entity does not exist yet (PR12), so
   * the check runs as a scoped DataSource query.
   */
  async update(
    id: string,
    updateSurgeryDto: UpdateSurgeryDto,
  ): Promise<Surgery> {
    try {
      const surgery = await this.surgeryRepository.findOne({ where: { id } });
      if (!surgery) throw new NotFoundException('Surgery not found');
      if (
        updateSurgeryDto.totalCost !== undefined &&
        updateSurgeryDto.totalCost !== surgery.totalCost
      ) {
        await this.assertNoPaymentPlan(surgery.id);
      }
      Object.assign(surgery, updateSurgeryDto);
      return await this.surgeryRepository.save(surgery);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * T6: status change + audit entry in ONE transaction. The audit entry is
   * written through AuditService.log with the transaction's manager, so it
   * commits or rolls back with the status change (design AD3).
   */
  async updateStatus(
    id: string,
    updateSurgeryStatusDto: UpdateSurgeryStatusDto,
    currentUser: User,
  ): Promise<Surgery> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const surgery = await manager.findOne(Surgery, { where: { id } });
        if (!surgery) throw new NotFoundException('Surgery not found');

        const previousData = { status: surgery.status };
        surgery.status = updateSurgeryStatusDto.status;
        await manager.save(surgery);

        await this.auditService.log(manager, {
          userId: currentUser.id,
          action: AUDIT_ACTION_STATUS_CHANGED,
          tableName: AUDIT_TABLE_SURGERIES,
          recordId: surgery.id,
          previousData,
          newData: { status: surgery.status },
        });
        return surgery;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  async assignDoctor(
    surgeryId: string,
    assignDoctorDto: AssignDoctorDto,
  ): Promise<SurgeryDoctor> {
    try {
      const surgery = await this.surgeryRepository.findOne({
        where: { id: surgeryId },
      });
      if (!surgery) throw new NotFoundException('Surgery not found');
      const doctor = await this.doctorRepository.findOne({
        where: { id: assignDoctorDto.doctorId },
      });
      if (!doctor) throw new NotFoundException('Doctor not found');

      const existing = await this.surgeryDoctorRepository.findOne({
        where: {
          surgeryId,
          doctorId: assignDoctorDto.doctorId,
        },
      });
      if (existing) {
        throw new ConflictException(
          'Doctor is already assigned to this surgery',
        );
      }

      const assignment = this.surgeryDoctorRepository.create({
        surgeryId,
        doctorId: assignDoctorDto.doctorId,
        role: assignDoctorDto.role ?? SurgeryDoctorRole.PRINCIPAL,
      });
      return await this.surgeryDoctorRepository.save(assignment);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // A second principal insert violates uq_one_principal_per_surgery
      // (23505 -> 409 via the shared handler).
      handleDatabaseError(error);
    }
  }

  /**
   * T7: reassign the principal = demote the current principal then promote the
   * new doctor, in ONE transaction. The partial unique index is per-statement,
   * so the demote must precede the promote: after the demote the surgery has
   * zero principals (allowed), after the promote exactly one — never two, and
   * the intermediate zero-principal state is invisible outside the
   * transaction.
   */
  async reassignPrincipal(
    surgeryId: string,
    reassignPrincipalDto: ReassignPrincipalDto,
  ): Promise<SurgeryDoctor> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const surgery = await manager.findOne(Surgery, { where: { id: surgeryId } });
        if (!surgery) throw new NotFoundException('Surgery not found');
        const doctor = await manager.findOne(Doctor, {
          where: { id: reassignPrincipalDto.doctorId },
        });
        if (!doctor) throw new NotFoundException('Doctor not found');

        const currentPrincipal = await manager.findOne(SurgeryDoctor, {
          where: { surgeryId, role: SurgeryDoctorRole.PRINCIPAL },
        });
        if (
          currentPrincipal &&
          currentPrincipal.doctorId === reassignPrincipalDto.doctorId
        ) {
          throw new ConflictException(
            'Doctor is already the principal of this surgery',
          );
        }

        const targetAssignment = await manager.findOne(SurgeryDoctor, {
          where: {
            surgeryId,
            doctorId: reassignPrincipalDto.doctorId,
          },
        });

        if (currentPrincipal) {
          currentPrincipal.role = SurgeryDoctorRole.ASSISTANT;
          await manager.save(currentPrincipal);
        }

        if (targetAssignment) {
          targetAssignment.role = SurgeryDoctorRole.PRINCIPAL;
          return await manager.save(targetAssignment);
        }
        const promoted = manager.create(SurgeryDoctor, {
          surgeryId,
          doctorId: reassignPrincipalDto.doctorId,
          role: SurgeryDoctorRole.PRINCIPAL,
        });
        return await manager.save(promoted);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  private async assertNoPaymentPlan(surgeryId: string): Promise<void> {
    const rows: { exists: boolean }[] = await this.dataSource.query(
      'SELECT EXISTS (SELECT 1 FROM payment_plans WHERE surgery_id = $1) AS exists',
      [surgeryId],
    );
    if (rows[0].exists) {
      throw new ConflictException(
        'total_cost cannot change once a payment plan exists for this surgery',
      );
    }
  }
}
