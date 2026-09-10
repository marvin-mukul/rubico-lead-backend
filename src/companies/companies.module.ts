import { Module } from '@nestjs/common';
import { CompanyRepository } from './company.repository.js';
import { FitFilterService } from './fit-filter.service.js';
import { SuppressionService } from './suppression.service.js';

@Module({
  providers: [CompanyRepository, SuppressionService, FitFilterService],
  exports: [CompanyRepository, SuppressionService, FitFilterService],
})
export class CompaniesModule {}
