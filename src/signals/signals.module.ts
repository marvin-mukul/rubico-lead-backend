import { Module } from '@nestjs/common';
import { CompoundService } from './compound.service.js';
import { SignalRepository } from './signal.repository.js';

@Module({
  providers: [SignalRepository, CompoundService],
  exports: [SignalRepository, CompoundService],
})
export class SignalsModule {}
