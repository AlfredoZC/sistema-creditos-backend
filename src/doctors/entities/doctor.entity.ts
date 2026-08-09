import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../auth/entities/user.entity';
import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('doctors')
export class Doctor {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'user_id', unique: true })
  userId: string;

  @ApiProperty()
  @Column('text')
  specialty: string;

  @ApiProperty()
  @Column('text', { name: 'professional_license', unique: true })
  professionalLicense: string;

  // Profile columns mirror the patients DDL exactly (AD1). DDL is
  // migration-owned: the metadata below mirrors the migration columns and is
  // never synchronize-applied (synchronize: false).
  @ApiProperty()
  @Column('varchar', { length: 50, name: 'first_name', default: '' })
  firstName: string;

  @ApiProperty()
  @Column('varchar', { length: 50, name: 'paternal_last_name', default: '' })
  paternalLastName: string;

  @ApiProperty({ nullable: true })
  @Column('varchar', { length: 50, name: 'maternal_last_name', nullable: true })
  maternalLastName?: string | null;

  @ApiProperty()
  @Column('varchar', { length: 50, name: 'phone', unique: true, default: '' })
  phone: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
