import { Module } from "@nestjs/common";
import { AccessModule } from "./modules/access/access.module.ts";
import { AnalyticsModule } from "./modules/analytics/analytics.module.ts";
import { ConnectionsModule } from "./modules/connections/connections.module.ts";
import { DocumentsModule } from "./modules/documents/documents.module.ts";
import { SchedulingModule } from "./modules/scheduling/scheduling.module.ts";
import { SearchModule } from "./modules/search/search.module.ts";
import { SharingModule } from "./modules/sharing/sharing.module.ts";
import { SimonModule } from "./modules/simon/simon.module.ts";
import { SystemModule } from "./modules/system/system.module.ts";
import { VaultModule } from "./modules/vault/vault.module.ts";
import { WorkspaceModule } from "./modules/workspace/workspace.module.ts";

@Module({
  imports: [
    SystemModule,
    AccessModule,
    WorkspaceModule,
    DocumentsModule,
    SearchModule,
    SimonModule,
    SchedulingModule,
    VaultModule,
    SharingModule,
    ConnectionsModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
