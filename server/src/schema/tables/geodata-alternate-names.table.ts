import { Column, Index, PrimaryColumn, Table } from '@immich/sql-tools';

@Table({ name: 'geodata_alternate_names', primaryConstraintName: 'geodata_alternate_names_pkey' })
@Index({ name: 'idx_geodata_alternate_names_lookup', columns: ['geonameId', 'isolanguage', 'isPreferredName'] })
export class GeodataAlternateNamesTable {
  @PrimaryColumn({ type: 'integer' })
  id!: number;

  @Column({ type: 'integer' })
  geonameId!: number;

  @Column({ type: 'character varying', length: 7, nullable: true })
  isolanguage!: string | null;

  @Column({ type: 'character varying', length: 400 })
  name!: string;

  @Column({ type: 'boolean', default: false })
  isPreferredName!: boolean;

  @Column({ type: 'boolean', default: false })
  isShortName!: boolean;

  @Column({ type: 'boolean', default: false })
  isColloquial!: boolean;

  @Column({ type: 'boolean', default: false })
  isHistoric!: boolean;

  @Column({ type: 'character varying', nullable: true })
  validFrom!: string | null;

  @Column({ type: 'character varying', nullable: true })
  validTo!: string | null;
}
