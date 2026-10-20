import { registerEnumType } from '@nestjs/graphql';
import { ElderCareGroup } from '../care-group';

registerEnumType(ElderCareGroup, { name: 'ElderCareGroup' });
export { ElderCareGroup };
