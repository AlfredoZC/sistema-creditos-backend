import { ApiProperty } from '@nestjs/swagger';
import { Patient } from '../../patients/entities/patient.entity';
import { SurgeryCatalog } from '../../surgery-catalog/entities/surgery-catalog.entity';
import { decimalTransformer } from '../../common/transformers';
import { SurgeryStatus } from '../../common/enums';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SurgeryDoctor } from './surgery-doctor.entity';

@Entity('surgeries')
export class Surgery {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'patient_id' })
  patientId: string;

  @ManyToOne(() => Patient)
  @JoinColumn({ name: 'patient_id' })
  patient?: Patient;

  @ApiProperty()
  @Column('uuid', { name: 'surgery_catalog_id' })
  surgeryCatalogId: string;

  @ManyToOne(() => SurgeryCatalog)
  @JoinColumn({ name: 'surgery_catalog_id' })
  surgeryCatalog?: SurgeryCatalog;

  @ApiProperty()
  @Column('date', { name: 'scheduled_date' })
  scheduledDate: string;

  // Money column: pg always returns numerics as strings and JS floats would
  // corrupt precision (design AD2 / section 5.1). Defaulted from the catalog
  // base cost at creation (D2), overridable per patient.
  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'total_cost',
    transformer: decimalTransformer,
  })
  totalCost: string;

  @ApiProperty({ enum: SurgeryStatus, default: SurgeryStatus.SCHEDULED })
  @Column({
    type: 'enum',
    enum: SurgeryStatus,
    default: SurgeryStatus.SCHEDULED,
  })
  status: SurgeryStatus;

  @ApiProperty({ nullable: true })
  @Column('text', { nullable: true })
  notes?: string | null;

  // AD7: inverse side of the surgery_doctors join entity — used by the list
  // endpoint to embed each assignment with its doctor. The join column is
  // owned by SurgeryDoctor.surgery_id.
  @OneToMany(() => SurgeryDoctor, (assignment) => assignment.surgery)
  surgeryDoctors?: SurgeryDoctor[];
}
