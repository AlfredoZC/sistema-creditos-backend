import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../auth/entities/user.entity';
import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('patients')
export class Patient {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'user_id', nullable: true, unique: true })
  userId: string | null;

  @ApiProperty()
  @Column('varchar', { length: 20, name: 'identity_document', unique: true })
  identityDocument: string;

  @ApiProperty()
  @Column('varchar', { length: 50, name: 'first_name' })
  firstName: string;

  @ApiProperty()
  @Column('varchar', { length: 50, name: 'paternal_last_name' })
  paternalLastName: string;

  @ApiProperty({ nullable: true })
  @Column('varchar', { length: 50, name: 'maternal_last_name', nullable: true })
  maternalLastName?: string | null;

  @ApiProperty({ nullable: true })
  @Column('date', { name: 'birth_date', nullable: true })
  birthDate?: string | null;

  @ApiProperty({ nullable: true })
  @Column('varchar', { length: 100, nullable: true })
  address?: string | null;

  @ApiProperty()
  @Column('varchar', { length: 50, unique: true })
  phone: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User | null;
}
