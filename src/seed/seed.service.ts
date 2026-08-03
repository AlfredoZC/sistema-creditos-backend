import { User } from './../auth/entities/user.entity';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { initialData } from './data/seed-data';

@Injectable()
export class SeedService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async runSeed(): Promise<string> {
    await this.deleteTables();
    await this.insertUsers();

    return 'SEED EXECUTED';
  }

  private async deleteTables(): Promise<void> {
    await this.dataSource.query(
      `TRUNCATE TABLE "audit_logs", "payments", "payment_plans", "installments",
        "surgery_doctors", "surgeries", "surgery_catalog", "patients", "doctors",
        "users", "profiles" RESTART IDENTITY CASCADE`,
    );
  }

  private async insertUsers(): Promise<void> {
    const seedUsers = initialData.users;

    const users: User[] = [];

    seedUsers.forEach((user) => {
      users.push(this.userRepository.create(user));
    });

    await this.userRepository.save(users);
  }
}
