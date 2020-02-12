import { MetricsEvent} from '@carto/toolkit-core';
import { SQL } from '@carto/toolkit-sql/dist/types/Client';
import { ColumConfig } from '@carto/toolkit-sql/dist/types/DDL';
import { DuplicatedDatasetsError } from '../errors/DuplicatedDataset';
import {
  CompleteVisualization,
  Dataset,
  StoredDataset,
  StoredVisualization,
  Visualization } from '../StorageRepository';
import {
  generateDatasetTableName,
  generateDatasetVisTableName,
  generateVisTableName,
  getDatasetData,
  getVisualization,
  rowToVisualization} from './utils';

export class SQLStorage {
  protected _tableName: string;
  protected _datasetsTableName: string;
  protected _datasetsVisTableName: string;
  private _sql: SQL;
  private _isPublic: boolean;
  private _isReady: boolean = false;
  private _namespace: string;
  private VIS_FIELDS: { [property: string]: ColumConfig };
  private DATASET_COLUMNS: string[];
  private DATASET_VIS_COLUMNS: string[];
  private FIELD_NAMES: string[];
  private FIELD_NAMES_INSERT: string[];

  constructor(
    tableName: string,
    sqlClient: SQL,
    version: number,
    isPublic: boolean) {
    this._namespace = tableName;
    this._tableName = generateVisTableName(tableName, isPublic, version);
    this._datasetsTableName = generateDatasetTableName(this._tableName);
    this._datasetsVisTableName = generateDatasetVisTableName(this._tableName);
    this._isPublic = isPublic;

    this.VIS_FIELDS = {
      id: { name: 'id', type: 'uuid', extra: `PRIMARY KEY DEFAULT ${this._namespace}_create_uuid()`, omitOnInsert: true },
      name: { name: 'name', type: 'text', extra: 'NOT NULL', format: this.escapeOrNull },
      description: { name: 'description', type: 'text', format: this.escapeOrNull },
      thumbnail: { name: 'thumbnail', type: 'text', format: this.escapeOrNull },
      isPrivate: {
        name: 'isPrivate', type: 'boolean', format: (isPrivate: boolean) => isPrivate === undefined ? false : isPrivate
      },
      config: { name: 'config', type: 'json', format: this.escapeOrNull },
      lastModified: { name: 'lastModified', type: 'timestamp', extra: 'NOT NULL DEFAULT now()', omitOnInsert: true }
    };


    this.DATASET_COLUMNS = [
      `id uuid PRIMARY KEY DEFAULT ${this._namespace}_create_uuid()`,
      `tablename text UNIQUE NOT NULL`,
      `name text UNIQUE NOT NULL`
    ];

    this.DATASET_VIS_COLUMNS = [
      // TODO: Reenable foreign keys when https://github.com/CartoDB/cartodb/issues/15161 is solved
      `vis uuid NOT NULL`, // `vis uuid references ${this._tableName}(id) ON DELETE CASCADE`,
      `dataset uuid NOT NULL` // `dataset uuid references ${this._datasetsTableName}(id) ON DELETE CASCADE`
    ];

    this.FIELD_NAMES = (Object.values(this.VIS_FIELDS) as ColumConfig[])
      .map((field) => field.name);

    this.FIELD_NAMES_INSERT = (Object.values(this.VIS_FIELDS) as ColumConfig[])
      .filter((field) => !field.omitOnInsert)
      .map((field) => field.name);

    this._sql = sqlClient;
  }

  /**
   * Ensures custom storage tables are ready
   */
  public async init(event?: MetricsEvent) {
    const missing = await this._checkMissingTables(); // notice how the previous checks don't propagate the event...
    if (missing) {
      await this._initTables(event); // ...but the real initialization does
    }
    this._isReady = true;
    return missing;
  }

  public getVisualizations(): Promise<StoredVisualization[]> {
    return this._sql.query(`
      SELECT ${this.FIELD_NAMES.filter((name) => name !== 'config').join(', ')}
      FROM ${this._tableName}
      `).then((response: any) => {

      if (response.error) {
        throw new Error(response.error);
      }

      if (response.rows.length === 0) {
        return [];
      }

      return response.rows.map(rowToVisualization);
    });
  }

  public async getVisualization(id: string): Promise<CompleteVisualization | null> {
    return getVisualization(this._tableName, this._datasetsTableName, this._datasetsVisTableName, id, this._sql);
  }

  public async getDatasetData(name: string, tablename: string): Promise<Dataset> {
    return getDatasetData(name, tablename, this._sql);
  }

  public async getDataset(name: string, event?: MetricsEvent): Promise<StoredDataset | null> {
    const result: any = await this._sql.query(`
      SELECT * FROM ${this._datasetsTableName} WHERE name='${name}'
    `, [], event);

    if (result.error) {
      throw new Error(`Failed to get dataset ${name}`);
    }

    return result.rows[0] || null;
  }

  public async getDatasets(): Promise<StoredDataset[]> {
    const result: any = await this._sql.query(`
      SELECT * FROM ${this._datasetsTableName}
    `);

    if (result.error) {
      throw new Error('Failed to read datasets');
    }

    return result.rows;
  }

  public async getVisForDataset(datasetId: string): Promise<StoredVisualization[]> {
    const result: any = await this._sql.query(`
      WITH dataset_vis as (SELECT * FROM ${this._datasetsVisTableName} WHERE dataset = '${datasetId}')

      SELECT t.name, t.id, t.thumbnail, t.isprivate
      FROM ${this._tableName} t, dataset_vis u WHERE t.id = u.vis
    `);

    if (result.error) {
      throw new Error('Failed to read visualizations');
    }

    return result.rows.map(rowToVisualization);
  }

  public async deleteVisualization(id: string): Promise<void> {
    // Delete visualization - dataset relation
    await this._sql.query(`DELETE FROM ${this._datasetsVisTableName} WHERE vis='${id}'`);

    // Delete visualization
    await this._sql.query(`DELETE FROM ${this._tableName} WHERE id='${id}'`);

    // Delete (not shared) datasets
    await this.deleteOrphanDatasets();
  }

  public async deleteDataset() {
    // Find all related visualizations
    // Delete them
    // Delete the dataset
    throw new Error('deleteDataset Not implemented yet');
  }

  public async createVisualization(
    vis: Visualization,
    datasets: Array<Dataset|string>,
    overwriteDatasets: boolean = false,
    event?: MetricsEvent): Promise<StoredVisualization | null> {

    await this.preventAccidentalDatasetsOverwrite(overwriteDatasets, datasets);

    const insertedVis = await this.insertVisTable(vis, event);
    if (insertedVis === null) {
      return null;
    }

    await this.uploadAndLinkDatasetsTo(insertedVis.id, datasets, overwriteDatasets, vis.isPrivate, event);

    return {
      ...insertedVis,
      ...vis
    };
  }

  public async uploadDataset(dataset: Dataset, overwrite: boolean = false, event?: MetricsEvent): Promise<StoredDataset> {
    const tableName = `${this._tableName}_${dataset.name}`;

    if (!dataset.columns) {
      throw new Error('Need dataset column information');
    }

    const storedDataset = await this.getDataset(dataset.name, event);

    if (overwrite && storedDataset !== null) {
      await this._sql.query(`DROP TABLE IF EXISTS ${tableName}`, [], event);
    }

    const result: any = await this._sql.create(tableName, dataset.columns, { ifNotExists: false }, event);

    if (result.error) {
      throw new Error(`Failed to create table for dataset ${dataset.name}: ${result.error}`);
    }

    let copyResult: any;
    try {
      const fields = dataset.columns.map((column) => {
        if (typeof column === 'string') {
          return column;
        }
        return column.name;
      });
      copyResult = await this._sql.copyFrom(dataset.file, tableName, fields, event);
    } catch (error) {
      throw new Error(`Failed to copy to ${tableName}: ${error.message}`);
    }
    if (copyResult.error) {
      throw new Error(`Failed to copy to ${tableName}: ${copyResult.error}`);
    }

    if (storedDataset === null) {
      const insertResult: any = await this._sql.query(`
        INSERT INTO ${this._datasetsTableName} (id, name, tablename)
        VALUES (${this._namespace}_create_uuid(), '${dataset.name}', '${tableName}')
        RETURNING *
      `, [], event);

      if (insertResult.error) {
        throw new Error(`Failed to register dataset ${tableName} ${insertResult.error}`);
      }

      return insertResult.rows[0];
    }

    return storedDataset;
  }

  public shareDataset(tableName: string, event?: MetricsEvent) {
    return this._sql.grantPublicRead(tableName, event);
  }

  public async updateVisualization(vis: StoredVisualization, datasets: Dataset[]): Promise<any> {

    const updatedVis = await this.updateVisTable(vis);
    if (updatedVis === null) {
      return null;
    }

    await this.cleanVisAndDatasetLinks(updatedVis.id);

    await this.uploadAndLinkDatasetsTo(updatedVis.id, datasets, true, vis.isPrivate);

    await this.deleteOrphanDatasets();

    return {
      ...vis,
      ...updatedVis
    };
  }

  public get isReady(): boolean {
    return this._isReady;
  }

  public setApiKey(apiKey: string) {
    this._sql.setApiKey(apiKey);
  }

  public async destroy() {
    const rawDatasets = await this.getDatasets();

    const datasets: string[] = rawDatasets.map((row: { name: string }) => row.name);

    // NOTE: DROP TABLE CASCADE removes dependant views or functions and foreign keys constraints (neither tables nor data)
    return this._sql.query(`
      BEGIN;
        ${datasets.map((datasetName) => `DROP TABLE IF EXISTS ${datasetName};`).join('\n')}
        DROP TABLE IF EXISTS ${this._tableName} CASCADE;
        DROP TABLE IF EXISTS ${this._datasetsTableName} CASCADE;
        DROP TABLE IF EXISTS ${this._datasetsVisTableName} CASCADE;
      COMMIT;
    `);
  }

  // Private methods

  private async checkIfDatasetExists(datasetOrName: Dataset|string): Promise<StoredDataset | null> {
    const name = typeof datasetOrName === 'string' ? datasetOrName : datasetOrName.name;

    const result: any = await this._sql.query(`SELECT * FROM ${this._datasetsTableName} WHERE name = '${name}'`);

    if (result.error) {
      throw new Error(result.error);
    }

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  private async preventAccidentalDatasetsOverwrite(overwriteDatasets: boolean, datasets: Array<Dataset|string>) {
    const fullDatasets = datasets.filter((dataset): dataset is Dataset => typeof dataset !== 'string');
    const existingTables = await this.checkExistingDataset(fullDatasets);
    if (!overwriteDatasets) {
      if (existingTables.length > 0) {
        throw new DuplicatedDatasetsError(existingTables.map((dataset) => dataset.name));
      }
    }
  }

  private async deleteOrphanDatasets() {
    // Delete any dataset that is not used by any other visualization.
    // This makes sense if datasets have not been cartodbfied, so they are just 'weak entities',
    // tied to visualizations. Once cartodbfied, the drop could not make sense anymore.

    // Drop the orphan datasets themselves
    const result: any = await this._sql.query(`
      SELECT * FROM ${this._datasetsTableName} WHERE id NOT IN (SELECT distinct(dataset) FROM ${this._datasetsVisTableName})
    `);
    const drops = result.rows.map((row: any) => { this._sql.drop(row.tablename, { ifExists: true}); });
    await Promise.all(drops);

    // Delete the reference to those datasets
    await this._sql.query(`DELETE FROM ${this._datasetsTableName} WHERE id NOT IN (SELECT distinct(dataset) FROM ${this._datasetsVisTableName})`);
  }

  private async insertVisTable(vis: Visualization, event?: MetricsEvent) {
     const insert = `INSERT INTO ${this._tableName}
     (${this.FIELD_NAMES_INSERT.join(', ')})
     VALUES
     (
       ${
         this.FIELD_NAMES_INSERT
           .map((field: string) => {
             const visField = this.VIS_FIELDS[field];
             const fieldValue = (vis as any)[field];

             const value = visField && visField.format ? visField.format(fieldValue) : fieldValue;
             return value === null ? 'null' : value;
           })
           .join()
       }
     )
     RETURNING id, lastmodified
   `;
     const insertResult: any = await this._sql.query(insert, [], event);

     if (insertResult.error) {
      throw new Error(insertResult.error);
    }

     const insertedVis = insertResult.rows[0];
     return {
      id: insertedVis.id,
      lastModified: insertedVis.lastmodified
    };
  }

  private async updateVisTable(vis: StoredVisualization) {
    const updatedResult: any = await this._sql.query(`UPDATE ${this._tableName}
    SET
      ${
        this.FIELD_NAMES_INSERT
          .map((field: string) => {
            const visField = this.VIS_FIELDS[field];
            const fieldValue = (vis as any)[field];

            const value = visField && visField.format ? visField.format(fieldValue) : fieldValue;
            return `${field} = ${value === null ? 'null' : value}`;
          })
          .join()
      }
      ,${this.VIS_FIELDS.lastModified.name}=NOW()
    WHERE ${this.VIS_FIELDS.id.name} = '${vis.id}'
    RETURNING ${this.VIS_FIELDS.id.name}, ${this.VIS_FIELDS.lastModified.name}
  `);

    if (updatedResult.error) {
      throw new Error(updatedResult.error);
   }

    return {
     id: vis.id,
     lastModified: updatedResult.rows.length ? updatedResult.rows[0].lastmodified : vis.lastModified
   };

 }

  private async uploadAndLinkDatasetsTo(
    visId: string,
    datasets: Array<Dataset|string>,
    overwriteDatasets: boolean,
    isPrivateVis: boolean,
    event?: MetricsEvent) {

    for (const dataset of datasets) {
      let tableName: string;

      // User has specified an already stored dataset as a data source
      if (typeof dataset === 'string') {
        const storedDataset = await this.getDataset(dataset);

        if (storedDataset === null) {
          // Fail silently for now. We'd have to be able to undo everything to fail properly.
          continue;
        }

        tableName = storedDataset.tablename;

        await this.linkVisAndDataset(visId, storedDataset.id, event);
      } else {
        const storedDataset = await this.uploadDataset(dataset, overwriteDatasets, event);
        tableName = storedDataset.tablename;

        await this.linkVisAndDataset(visId, storedDataset.id, event);


        // Creating the cartodbified version
        // BEGIN;
        // CREATE TABLE <tableName_cartodbified> AS (select * from previousTable);
        // We'll need some extra user info for this step, fetch this early on.
        // CARTODBFY(...);
        // END;
      }

      // GRANT READ to datasets
      if (!isPrivateVis) {
        await this.shareDataset(tableName, event);
      }
    }
  }

  private async checkExistingDataset(datasets: Array<string|Dataset>): Promise<StoredDataset[]> {
    const result = await Promise.all(datasets.map((dataset) => this.checkIfDatasetExists(dataset)));

    return result.filter((element): element is StoredDataset => element !== null);
  }

  private escapeOrNull(what: string) {
    if (what === null) {
      return null;
    }

    return `'${what}'`;
  }

  // Removes existing links with a certain visualization
  private async cleanVisAndDatasetLinks(visId: string) {
    const cleanResult: any = await this._sql.query(`
      DELETE FROM ${this._datasetsVisTableName}
      WHERE vis='${visId}'
    `);

    if (cleanResult.error) {
      throw new Error(`Failed to clean vis-dataset links for visualization '${visId}'`);
    }
  }

  private async linkVisAndDataset(visId: string, datasetId: string, event?: MetricsEvent) {
    const insert = `
      INSERT INTO ${this._datasetsVisTableName} (vis, dataset)
      VALUES ('${visId}', '${datasetId}')
    `;
    const insertResult: any = await this._sql.query(insert, [], event);

    if (insertResult.error) {
      throw new Error('Failed to link dataset id to vis id');
    }
  }

  /**
   * Checks if all the tables for SQLStorage exist
   */
  private async _checkMissingTables() {
    const requiredTables = [this._tableName, this._datasetsTableName, this._datasetsVisTableName];

    const checksTablesAreReady = requiredTables.map((table) => this._sql.query(`SELECT to_regclass('${table}')`));
    const results = await Promise.all(checksTablesAreReady);
    const missingTables = results.some((response: any) => {
      const tableIsMissing = (response.rows[0].to_regclass === null);
      return tableIsMissing;
    });
    return missingTables;
  }

  /**
   * Creates missing required tables for custom storage
   */
  private async _initTables(event?: MetricsEvent) {
    await this._sql.create(this._tableName, [...Object.values(this.VIS_FIELDS)], {
      ifNotExists: true
    }, event);

    await this._sql.create(this._datasetsTableName, this.DATASET_COLUMNS, {
      ifNotExists: true
    }, event);

    await this._sql.create(this._datasetsVisTableName, this.DATASET_VIS_COLUMNS, {
      ifNotExists: true
    }, event);

    // TODO: If they are already granted, no point in following
    if (this._isPublic) {
      await this._sql.grantPublicRead(this._tableName, event);
      await this._sql.grantPublicRead(this._datasetsTableName, event);
      await this._sql.grantPublicRead(this._datasetsVisTableName, event);
    }
  }
}
