import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { decimalTransformer } from '../../common/transformers';

@Entity('surgery_catalog')
export class SurgeryCatalog {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('varchar', { length: 50 })
  name: string;

  @ApiProperty({ nullable: true })
  @Column('text', { nullable: true })
  description?: string | null;

  // Money column: pg always returns numerics as strings and JS floats would
  // corrupt precision (design AD2 / section 5.1).
  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'base_cost',
    transformer: decimalTransformer,
  })
  baseCost: string;
}
