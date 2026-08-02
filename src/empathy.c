#include "empathy_internal.h"

#include <assert.h>
#include <string.h>

/*
 */
typedef struct Empathy_InstanceInternal_t
{
	Empathy_InstanceTable *vtbl;
} Empathy_InstanceInternal;

/*
 */
Empathy_Result empathyCreateInstance(const Empathy_InstanceDesc *desc, Empathy_Instance *instance)
{
	return impl_createInstance(desc, instance);
}

Empathy_Result empathyGetInstanceTable(Empathy_Instance instance, Empathy_InstanceTable *instance_table)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	if (instance_table == NULL)
		return EMPATHY_INVALID_OUTPUT_ARGUMENT;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);

	memcpy(instance_table, ptr->vtbl, sizeof(Empathy_InstanceTable));
	return EMPATHY_SUCCESS;
}

/*
 */
Empathy_Result empathyDestroyInstance(Empathy_Instance instance)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->destroyInstance);

	return ptr->vtbl->destroyInstance(instance);
}
