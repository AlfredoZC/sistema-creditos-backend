import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('profiles')
export class Profile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text', { default: 'No especificado' })
  gender?: string;

  @Column('text', { default: '' })
  photo: string;

  @Column('text', { default: '' })
  photoPublicId: string;
}
