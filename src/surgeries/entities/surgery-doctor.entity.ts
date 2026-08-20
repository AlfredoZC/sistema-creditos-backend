import { ApiProperty } from '@nestjs/swagger';
import { Doctor } from '../../doctors/entities/doctor.entity';
import { SurgeryDoctorRole } from '../../common/enums';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Surgery } from './surgery.entity';

/**
 * Explicit join entity for doctor assignments (design AD11): the migration
 * owns the DDL — UNIQUE(surgery_id, doctor_id) plus the partial unique index
 * uq_one_principal_per_surgery that enforces exactly one principal per
 * surgery. The decorators below mirror that DDL in TypeORM metadata.
 */
@Entity('surgery_doctors')
@Index('uq_surgery_doctors_surgery_doctor', ['surgeryId', 'doctorId'], {
  unique: true,
})
@Index('uq_one_principal_per_surgery', ['surgeryId'], {
  unique: true,
  where: "role = 'principal'",
})
export class SurgeryDoctor {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'surgery_id' })
  surgeryId: string;

  @ManyToOne(() => Surgery)
  @JoinColumn({ name: 'surgery_id' })
  surgery?: Surgery;

  @ApiProperty()
  @Column('uuid', { name: 'doctor_id' })
  doctorId: string;

  @ManyToOne(() => Doctor)
  @JoinColumn({ name: 'doctor_id' })
  doctor?: Doctor;

  @ApiProperty({
    enum: SurgeryDoctorRole,
    default: SurgeryDoctorRole.PRINCIPAL,
  })
  @Column({
    type: 'enum',
    enum: SurgeryDoctorRole,
    default: SurgeryDoctorRole.PRINCIPAL,
  })
  role: SurgeryDoctorRole;
}
