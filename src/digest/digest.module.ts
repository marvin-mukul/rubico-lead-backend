import { Module } from '@nestjs/common';
import { DigestController } from './digest.controller.js';
import { DigestService } from './digest.service.js';

@Module({
  controllers: [DigestController],
  providers: [DigestService],
  exports: [DigestService],
})
export class DigestModule {}
