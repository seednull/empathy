#include <empathy.h>
#include <vector>
#include <cassert>

struct WorldState
{
	uint32_t day {42};
	float time {42.0f};
};

struct LocalState
{
	float time {0.0f};
};

static WorldState world_state = {};
static LocalState local_state = {};

void testMachine(Empathy_Instance instance)
{
	Empathy_ParameterDesc world_parameters[] =
	{
		{0, {EMPATHY_VALUE_BASE_TYPE_UINT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_READ, offsetof(WorldState, day)},
		{1, {EMPATHY_VALUE_BASE_TYPE_FLOAT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_READ, offsetof(WorldState, time)},
	};

	Empathy_ParameterDesc local_parameters[] =
	{
		{0, {EMPATHY_VALUE_BASE_TYPE_FLOAT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_READ_WRITE, offsetof(LocalState, time)},
	};

	Empathy_ParameterTableDesc tables[]
	{
		{0, 2, world_parameters},
		{1, 1, local_parameters},
	};

	Empathy_ProgramLayoutDesc layout_desc =
	{
		0, nullptr,
		2, tables,
		0, nullptr,
	};

	Empathy_ProgramLayout layout = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgramLayout(instance, &layout_desc, &layout);
	assert(result == EMPATHY_SUCCESS);

	/*
	 * load world_state, time
	 * store local_state, time
	 * end
	 */
	uint8_t payload[] =
	{
		0x0B, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x0C, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x22,
	};

	Empathy_ProgramDesc program_desc =
	{
		layout,
		sizeof(payload),
		payload
	};

	Empathy_Program program = EMPATHY_NULL_HANDLE;
	result = empathyCreateProgram(instance, &program_desc, &program);
	assert(result == EMPATHY_SUCCESS);

	Empathy_MachineDesc machine_desc =
	{
		32,
		32,
		8
	};

	Empathy_Machine machine = EMPATHY_NULL_HANDLE;
	result = empathyCreateMachine(instance, &machine_desc, &machine);
	assert(result == EMPATHY_SUCCESS);

	result = empathyBindProgram(instance, machine, program);
	assert(result == EMPATHY_SUCCESS);

	result = empathyBindParameterTable(instance, machine, 0, sizeof(WorldState), &world_state);
	assert(result == EMPATHY_SUCCESS);

	result = empathyBindParameterTable(instance, machine, 1, sizeof(LocalState), &local_state);
	assert(result == EMPATHY_SUCCESS);

	assert(local_state.time == 0.0f);

	result = empathyRun(instance, machine, 3);
	assert(result == EMPATHY_EXECUTION_END);

	assert(local_state.time == world_state.time);

	result = empathyDestroyMachine(instance, machine);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgram(instance, program);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgramLayout(instance, layout);
	assert(result == EMPATHY_SUCCESS);
}

int main()
{
	Empathy_Instance instance = EMPATHY_NULL_HANDLE;

	Empathy_InstanceDesc instance_desc =
	{
	};

	Empathy_Result result = empathyCreateInstance(&instance_desc, &instance);
	assert(result == EMPATHY_SUCCESS);

	testMachine(instance);

	result = empathyDestroyInstance(instance);
	assert(result == EMPATHY_SUCCESS);

	return 0;
}
