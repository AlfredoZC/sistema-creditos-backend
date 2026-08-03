import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import * as bcrypt from 'bcrypt';

import { User } from './entities/user.entity';
import {
  CreateStaffUserDto,
  CreateUserDto,
  LoginUserDto,
} from './dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { JwtService } from '@nestjs/jwt';
import { Profile } from '../profile/entities/profile.entity';
import { UserRole } from '../common/enums';
import { handleDatabaseError } from '../common/errors';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
  ) {}

  async create(createUserDto: CreateUserDto) {
    try {
      const { password, ...userData } = createUserDto;

      const profile = new Profile();
      await this.dataSource.manager.save(profile);

      const user = this.userRepository.create({
        ...userData,
        password: bcrypt.hashSync(password, 10),
        role: UserRole.PATIENT,
        profile,
      });

      await this.userRepository.save(user);
      delete user.password;
      return {
        ...user,
        token: this.getJwtToken({ id: user.id }),
      };
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  async createStaffUser(createStaffUserDto: CreateStaffUserDto) {
    try {
      const { password, ...userData } = createStaffUserDto;

      const user = this.userRepository.create({
        ...userData,
        password: bcrypt.hashSync(password, 10),
      });

      await this.userRepository.save(user);
      delete user.password;
      return {
        ...user,
        token: this.getJwtToken({ id: user.id }),
      };
    } catch (error) {
      handleDatabaseError(error);
    }
  }

  async login(loginUserDto: LoginUserDto) {
    const { password, email } = loginUserDto;

    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.profile', 'profile')
      .select([
        'user.id',
        'user.email',
        'user.name',
        'user.role',
        'user.isActive',
        'user.password', // Incluso si select: false, puedes seleccionarla explícitamente
        'profile',
      ])
      .where('user.email = :email', { email })
      .getOne();

    if (!user)
      throw new UnauthorizedException('Credentials are not valid(email)');

    if (!bcrypt.compareSync(password, user.password))
      throw new UnauthorizedException('Credentials are not valid(password)');

    if (!user.isActive)
      throw new UnauthorizedException('User is inactive, talk with an admin');

    delete user.password;
    return {
      ...user,
      token: this.getJwtToken({ id: user.id }),
    };
  }

  async checkAuthStatus(user: User) {
    return {
      ...user,
      token: this.getJwtToken({ id: user.id }),
    };
  }

  async getAllFromUserAuth(id: string) {
    const user = await this.userRepository.findOne({
      relations: {
        profile: true,
      },
      where: {
        id,
      },
    });
    if (!user) throw new NotFoundException();
    return user;
  }

  private getJwtToken(payload: JwtPayload) {
    const token = this.jwtService.sign(payload);
    return token;
  }
}
