import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../common/enums';
import { Profile } from '../../profile/entities/profile.entity';
import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('varchar', {
    length: 255,
    unique: true,
  })
  email: string;

  @ApiProperty()
  @Column('varchar', {
    length: 255,
    select: false,
  })
  password: string;

  @ApiProperty()
  @Column('varchar', {
    length: 50,
  })
  name: string;

  @ApiProperty()
  @Column({ type: 'enum', enum: UserRole, name: 'role' })
  role: UserRole;

  @ApiProperty()
  @Column({
    name: 'is_active',
    default: true,
  })
  isActive: boolean;

  @OneToOne(() => Profile)
  @JoinColumn()
  profile: Profile;

  @BeforeInsert() //trigger
  checkFieldsBeforeInsert() {
    this.email = this.email.toLowerCase().trim();
  }

  @BeforeUpdate() //trigger
  checkFieldsBeforeUpdate() {
    this.checkFieldsBeforeInsert();
  }
}
