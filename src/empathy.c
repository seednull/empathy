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
Empathy_Result empathyCreateProgramLayout(Empathy_Instance instance, const Empathy_ProgramLayoutDesc *desc, Empathy_ProgramLayout *layout)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->createProgramLayout);

	return ptr->vtbl->createProgramLayout(instance, desc, layout);
}

Empathy_Result empathyCreateProgram(Empathy_Instance instance, const Empathy_ProgramDesc *desc, Empathy_Program *program)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->createProgram);

	return ptr->vtbl->createProgram(instance, desc, program);
}

Empathy_Result empathyCreateMachine(Empathy_Instance instance, const Empathy_MachineDesc *desc, Empathy_Machine *machine)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->createMachine);

	return ptr->vtbl->createMachine(instance, desc, machine);
}


Empathy_Result empathyDestroyProgramLayout(Empathy_Instance instance, Empathy_ProgramLayout layout)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->destroyProgramLayout);

	return ptr->vtbl->destroyProgramLayout(instance, layout);
}

Empathy_Result empathyDestroyProgram(Empathy_Instance instance, Empathy_Program program)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->destroyProgram);

	return ptr->vtbl->destroyProgram(instance, program);
}

Empathy_Result empathyDestroyMachine(Empathy_Instance instance, Empathy_Machine machine)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->destroyMachine);

	return ptr->vtbl->destroyMachine(instance, machine);
}

Empathy_Result empathyDestroyInstance(Empathy_Instance instance)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->destroyInstance);

	return ptr->vtbl->destroyInstance(instance);
}

Empathy_Result empathyBindProgram(Empathy_Instance instance, Empathy_Machine machine, Empathy_Program program)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->bindProgram);

	return ptr->vtbl->bindProgram(instance, machine, program);
}

Empathy_Result empathyBindParameterTable(Empathy_Instance instance, Empathy_Machine machine, uint32_t index, uint64_t size, void *data)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->bindParameterTable);

	return ptr->vtbl->bindParameterTable(instance, machine, index, size, data);
}

Empathy_Result empathyRun(Empathy_Instance instance, Empathy_Machine machine, uint32_t budget)
{
	if (instance == EMPATHY_NULL_HANDLE)
		return EMPATHY_INVALID_INSTANCE;

	Empathy_InstanceInternal *ptr = (Empathy_InstanceInternal *)instance;
	assert(ptr->vtbl);
	assert(ptr->vtbl->run);

	return ptr->vtbl->run(instance, machine, budget);
}
